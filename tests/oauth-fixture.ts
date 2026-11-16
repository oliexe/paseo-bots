import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

/** Real HTTP OAuth/MCP peer: validates resource, PKCE, client authentication and rotating refresh tokens. */
export async function oauthFixture() {
  let origin = "";
  const clients = new Map<string, { redirect_uris: string[]; client_secret?: string }>();
  const codes = new Map<string, { clientId: string; redirect: string; challenge: string; resource: string }>();
  const refreshTokens = new Map<string, { clientId: string; resource: string }>();
  const accessTokens = new Set<string>();
  const streams = new Map<string, ServerResponse>();
  const counts = { registrations: 0, exchanges: 0, refreshes: 0, calls: 0, unauthorized: 0, redirects: 0 };
  const options = { issuer: "", requireIssuer: true, omitIssuer: false, mismatchResource: false, pkce: true, dcr: true, oidc: false, denyToken: false, alwaysUnauthorized: false, redirect: false, tokenDelay: 0, expiresIn: 3600, omitRefreshOnRefresh: false, publicStream: false, ssePreamble: "", sseEndpointFields: "" };
  const requests: { path: string; authorization?: string; lastEventId?: string; body: string }[] = [];
  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
  const token = (clientId: string, resource: string, refreshing: boolean) => {
    const access = `access-${randomUUID()}`; const refresh = `refresh-${randomUUID()}`;
    accessTokens.add(access); refreshTokens.set(refresh, { clientId, resource });
    return { access_token: access, token_type: "Bearer", expires_in: options.expiresIn, scope: "tools:read", ...(!refreshing || !options.omitRefreshOnRefresh ? { refresh_token: refresh } : {}) };
  };
  const reply = (message: { id?: number; method: string }) => message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "echo", description: "OAuth tool", inputSchema: { type: "object" } }] } : message.method === "tools/call" ? (counts.calls++, { content: [{ type: "text", text: "Authenticated tool result" }] }) : {} };
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const url = new URL(req.url!, origin);
      requests.push({ path: url.pathname, authorization: req.headers.authorization, lastEventId: req.headers["last-event-id"] as string | undefined, body });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: options.mismatchResource ? `${origin}/another` : `${origin}${url.pathname.replace("/.well-known/oauth-protected-resource", "") || "/mcp"}`, authorization_servers: [origin], scopes_supported: ["tools:read"] });
      if (url.pathname === "/.well-known/oauth-authorization-server" && options.oidc) return json(res, 404, {});
      if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") return json(res, 200, {
        issuer: options.issuer || origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(options.dcr ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"], code_challenge_methods_supported: options.pkce ? ["S256"] : ["plain"], authorization_response_iss_parameter_supported: options.requireIssuer,
        jwks_uri: `${origin}/jwks`, subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      });
      if (url.pathname === "/register") {
        const metadata = JSON.parse(body); const clientId = `client-${randomUUID()}`;
        clients.set(clientId, metadata); counts.registrations++;
        return json(res, 201, { ...metadata, client_id: clientId });
      }
      if (url.pathname === "/authorize") {
        const clientId = url.searchParams.get("client_id")!; const client = clients.get(clientId);
        const redirect = url.searchParams.get("redirect_uri")!;
        if (!client?.redirect_uris.includes(redirect) || url.searchParams.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_client" });
        const code = randomUUID(); codes.set(code, { clientId, redirect, challenge: url.searchParams.get("code_challenge")!, resource: url.searchParams.get("resource")! });
        const callback = new URL(redirect); callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!);
        if (!options.omitIssuer) callback.searchParams.set("iss", origin);
        return res.writeHead(302, { location: callback.href }).end();
      }
      if (url.pathname === "/token") {
        if (options.tokenDelay) await new Promise((resolve) => setTimeout(resolve, options.tokenDelay));
        if (options.denyToken) return json(res, 400, { error: "invalid_grant", error_description: `Never expose ${body}` });
        const params = new URLSearchParams(body);
        let clientId = params.get("client_id")!; let secret = params.get("client_secret");
        if (req.headers.authorization?.startsWith("Basic ")) [clientId, secret] = Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":") as [string, string];
        if (!clients.has(clientId) || clients.get(clientId)?.client_secret && clients.get(clientId)?.client_secret !== secret) return json(res, 400, { error: "invalid_client" });
        if (params.get("grant_type") === "refresh_token") {
          const old = refreshTokens.get(params.get("refresh_token")!);
          if (!old || old.clientId !== clientId || old.resource !== params.get("resource")) return json(res, 400, { error: "invalid_grant" });
          if (!options.omitRefreshOnRefresh) refreshTokens.delete(params.get("refresh_token")!);
          counts.refreshes++; return json(res, 200, token(clientId, old.resource, true));
        }
        const code = codes.get(params.get("code")!); codes.delete(params.get("code")!);
        if (!code || code.clientId !== clientId || code.redirect !== params.get("redirect_uri") || code.resource !== params.get("resource") || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== code.challenge) return json(res, 400, { error: "invalid_grant" });
        counts.exchanges++; return json(res, 200, token(clientId, code.resource, false));
      }
      if (["/mcp", "/sse", "/messages"].includes(url.pathname)) {
        const auth = req.headers.authorization?.replace(/^Bearer /, "");
        if (options.publicStream && !auth) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": open public stream\n\n"); return; }
        if (options.alwaysUnauthorized || !auth || !accessTokens.has(auth)) { counts.unauthorized++; return json(res, 401, {}, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname === "/mcp" ? "/mcp" : "/sse"}", scope="tools:read"` }); }
        if (options.redirect) { counts.redirects++; return res.writeHead(307, { location: `${origin}/stolen` }).end(); }
        if (url.pathname === "/sse") {
          const session = randomUUID(); streams.set(session, res); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`${options.ssePreamble}event: endpoint\n${options.sseEndpointFields}data: /messages?session=${session}\n\n`); res.on("close", () => streams.delete(session)); return;
        }
        if (req.method === "DELETE") return res.writeHead(204).end();
        if (req.method !== "POST") return res.writeHead(405).end();
        const result = reply(JSON.parse(body));
        if (url.pathname === "/messages") { if (result) streams.get(url.searchParams.get("session")!)?.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`); return res.writeHead(202).end(); }
        return result ? json(res, 200, result) : res.writeHead(202).end();
      }
      return json(res, 404, {});
    } catch { if (!res.headersSent) json(res, 500, { error: "fixture" }); else res.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, options, counts, clients, requests, accessTokens,
    async authorize(url: string) { const response = await fetch(url, { redirect: "manual" }); if (response.status !== 302) throw new Error("Fixture refused authorization"); return response.headers.get("location")!; },
    async close() { for (const stream of streams.values()) stream.end(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
