import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_NAME, RESERVED_MCP_NAMES, type McpServerConfig } from "../shared/bot";
import type { BotsHost } from "./host";
import { McpOAuth, OAuthNotice } from "./mcp-oauth";
import { rewriteSseEndpoints } from "./mcp-sse";
import { readBody, type Relay } from "./relay";

const PREFIX = "/mcp-oauth/proxy/";
const MAX_RESPONSE = 20 * 1024 * 1024;
const MAX_REQUEST = 5 * 1024 * 1024;

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }));
}

/** OAuth tokens stay on this host. Providers see only a scoped, revocable local bearer credential. */
export class McpOAuthProxy {
  private readonly requests = new Map<AbortController, string>();
  private readonly unsubscribe: () => void;
  private stopped = false;
  constructor(private readonly host: BotsHost, private readonly relay: Relay, readonly oauth: McpOAuth) {
    relay.addRoute((request, response, path) => this.route(request, response, path));
    this.unsubscribe = oauth.onInvalidate((id) => { for (const [controller, serverId] of this.requests) if (serverId === id) controller.abort(); });
  }

  async mount(serverId: string, botId: string, agentId: string): Promise<McpServerConfig> {
    if (this.stopped) throw new OAuthNotice("The plugin is stopping.");
    const server = await this.oauth.server(serverId);
    const subject = JSON.stringify([botId, agentId]);
    const parts = [serverId, botId, agentId].map(encodeURIComponent).join("/");
    const token = await this.oauth.proxyToken(serverId, subject);
    if (this.stopped) throw new OAuthNotice("The plugin is stopping.");
    const port = await this.relay.start();
    if (this.stopped) throw new OAuthNotice("The plugin is stopping.");
    return { type: server.config.type, url: `http://127.0.0.1:${port}${PREFIX}${parts}`, headers: { Authorization: `Bearer ${token}` } };
  }

  async servers(botId: string, agentId: string): Promise<Record<string, McpServerConfig>> {
    const values = await this.host.values();
    if (!values) throw new OAuthNotice("Bot settings are unavailable. Try again when they have loaded.");
    const bot = values.bots.find((entry) => entry.id === botId);
    if (!bot || bot.archived || bot.hostId) return {};
    const result: Record<string, McpServerConfig> = {};
    for (const server of values.library?.mcpServers ?? []) {
      if (server.enabled && MCP_NAME.test(server.name) && !RESERVED_MCP_NAMES.includes(server.name) && bot.mcpServerIds.includes(server.id) && server.config.type !== "stdio" && server.config.oauth) result[server.name] = await this.mount(server.id, botId, agentId);
    }
    return result;
  }

  private async route(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (path === "/mcp-oauth/callback") {
      if (this.stopped) { reply(response, 503, "The plugin is stopping."); return true; }
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${request.socket.localPort}`) { reply(response, 400, "Invalid OAuth callback."); return true; }
      try {
        await this.oauth.callback(`http://${request.headers.host}${request.url}`);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Connected. Return to Paseo; you can close this browser tab.");
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(error instanceof OAuthNotice ? error.message : "Couldn't complete sign-in. Return to Paseo and connect again.");
      }
      return true;
    }
    if (!path.startsWith(PREFIX)) return false;
    if (this.stopped) { reply(response, 503, "The plugin is stopping."); return true; }
    const parts = path.slice(PREFIX.length).split("/");
    if (parts.length !== 3 || parts.some((part) => !part || part.length > 600)) { reply(response, 404, "Unknown MCP connection."); return true; }
    let serverId: string, botId: string, agentId: string;
    try { [serverId, botId, agentId] = parts.map(decodeURIComponent) as [string, string, string]; } catch { reply(response, 400, "Invalid MCP connection."); return true; }
    const subject = JSON.stringify([botId, agentId]);
    try {
      if (!await this.oauth.verifyProxyToken(serverId, subject, request.headers.authorization)) { reply(response, 401, "Unauthorized MCP connection."); return true; }
      const server = await this.oauth.server(serverId);
      // A probe has a separate credential and can test a server before it is enabled.
      if (botId !== "probe" || agentId !== "probe") {
        const bot = await this.host.bot(botId);
        if (!bot || bot.archived || bot.hostId || !bot.mcpServerIds.includes(serverId) || !server.enabled) { reply(response, 403, "This bot no longer has access to this MCP server."); return true; }
      }
      if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) { response.writeHead(405, { allow: "GET, POST, DELETE" }).end(); return true; }
      const local = new URL(request.url!, `http://127.0.0.1:${request.socket.localPort}`);
      let target = server.config.url;
      if (local.search) {
        const endpoint = local.searchParams.get("endpoint");
        const signature = local.searchParams.get("signature");
        if (server.config.type !== "sse" || !endpoint || !signature || new URL(endpoint).origin !== new URL(target).origin || !await this.oauth.verifyProxyToken(serverId, `${subject}:${endpoint}`, `Bearer ${signature}`)) throw new OAuthNotice("Invalid SSE message endpoint.");
        target = endpoint;
      }
      await this.forward(request, response, serverId, subject, server.config, target, local.origin + local.pathname);
    } catch (error) {
      if (!response.headersSent) reply(response, error instanceof OAuthNotice ? 401 : 502, error instanceof OAuthNotice ? error.message : "Couldn't reach the MCP server. Test its connection in Skills & Tools.");
      else response.destroy();
    }
    return true;
  }

  private async forward(request: IncomingMessage, response: ServerResponse, id: string, subject: string, config: Exclude<McpServerConfig, { type: "stdio" }>, target: string, localUrl: string): Promise<void> {
    if (this.stopped) { reply(response, 503, "The plugin is stopping."); return; }
    const controller = new AbortController();
    this.requests.set(controller, id);
    const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
    timeout.unref();
    const closed = () => controller.abort();
    response.once("close", closed);
    const aborted = () => { if (!request.complete) request.destroy(new Error("MCP request canceled.")); };
    controller.signal.addEventListener("abort", aborted, { once: true });
    try {
      const bodyTimeout = setTimeout(() => controller.abort(), 30_000); bodyTimeout.unref();
      let body: string | undefined;
      try { body = request.method === "POST" ? await readBody(request, MAX_REQUEST) : undefined; }
      finally { clearTimeout(bodyTimeout); }
      const headers = new Headers(config.headers);
      headers.delete("authorization"); headers.delete("host"); headers.delete("cookie");
      for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
        const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
      }
      const send = async (token: string) => {
        if (!await this.oauth.verifyProxyToken(id, subject, request.headers.authorization)) throw new OAuthNotice("This MCP connection was disconnected or changed. Reopen the chat.");
        const [botId, agentId] = JSON.parse(subject) as [string, string];
        if (botId !== "probe" || agentId !== "probe") {
          const current = await this.oauth.server(id);
          const bot = await this.host.bot(botId);
          if (!bot || bot.archived || bot.hostId || !bot.mcpServerIds.includes(id) || !current.enabled) throw new OAuthNotice("This bot no longer has access to this MCP server.");
        }
        headers.set("Authorization", `Bearer ${token}`);
        // Never forward credentials through a redirect, even if the destination shares an origin.
        return fetch(target, { method: request.method, headers, body, redirect: "error", signal: controller.signal });
      };
      let token = await this.oauth.accessToken(id, undefined, config);
      let upstream = await send(token);
      // A 401 means the MCP request was unauthenticated. Refresh and retry it at most once.
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        token = await this.oauth.accessToken(id, token, config);
        upstream = await send(token);
      }
      if (upstream.status === 401 || upstream.status === 403) { await upstream.body?.cancel(); throw new OAuthNotice("The MCP server rejected this authorization. Reconnect it in Skills & Tools."); }
      const outgoing: Record<string, string> = { "cache-control": "no-store" };
      for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) { const value = upstream.headers.get(name); if (value) outgoing[name] = value; }
      response.writeHead(upstream.status, outgoing);
      if (!upstream.body) { response.end(); return; }
      if (config.type === "sse" && request.method === "GET" && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const rewrite = async (data: string) => {
          const endpoint = new URL(data, config.url);
          if (endpoint.origin !== new URL(config.url).origin || endpoint.username || endpoint.password || endpoint.hash) throw new OAuthNotice("The SSE server returned an unsafe message endpoint.");
          const signature = await this.oauth.proxyEndpointToken(id, subject, endpoint.href, request.headers.authorization, config);
          return `${localUrl}?endpoint=${encodeURIComponent(endpoint.href)}&signature=${signature}`;
        };
        for await (const chunk of rewriteSseEndpoints(upstream.body, rewrite)) {
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
        }
      } else {
        const reader = upstream.body.getReader();
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE) throw new OAuthNotice("The MCP response exceeds 20 MB.");
            if (!response.write(value)) await once(response, "drain", { signal: controller.signal });
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      response.end();
    } finally {
      clearTimeout(timeout); response.off("close", closed); controller.abort(); controller.signal.removeEventListener("abort", aborted); this.requests.delete(controller);
    }
  }

  stop(): void { this.stopped = true; this.unsubscribe(); for (const request of this.requests.keys()) request.abort(); this.requests.clear(); }
}
