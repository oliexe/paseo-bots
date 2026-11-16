import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { PluginHookEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpOAuth } from "../server/mcp-oauth";
import { McpOAuthProxy } from "../server/mcp-oauth-proxy";
import { allowsOAuthTool, registerMcpOAuthLifecycle } from "../server/mcp-oauth-lifecycle";
import { probeMcpServer } from "../server/mcp-probe";
import { Relay } from "../server/relay";
import { buildAgentConfig, type LibraryMcpServer } from "../shared/bot";
import { fakeHost, makeBot, NOW } from "./helpers";
import { oauthFixture } from "./oauth-fixture";

let directory: string; let previous: string | undefined;
let fixture: Awaited<ReturnType<typeof oauthFixture>>;
let oauth: McpOAuth; let proxy: McpOAuthProxy; let relay: Relay;
let libraryServer: LibraryMcpServer;
let host: ReturnType<typeof fakeHost>;
const file = () => join(directory, "plugin-data/paseo-bots/mcp-oauth.json");
beforeEach(async () => {
  const root = process.env.HS_TEMP || join(process.env.HOME!, "Temp"); await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, "paseo-mcp-oauth-test-")); previous = process.env.PASEO_HOME; process.env.PASEO_HOME = directory;
  fixture = await oauthFixture();
  libraryServer = { id: "mcp-test", name: "fixture", description: "", enabled: true, config: { type: "http", url: `${fixture.origin}/mcp`, headers: {}, oauth: true }, tools: null, checkError: null, checkedAt: null, createdAt: NOW, updatedAt: NOW };
  host = fakeHost([makeBot({ mcpServerIds: [libraryServer.id] })], { skills: [], mcpServers: [libraryServer] });
  relay = new Relay(host, []); oauth = new McpOAuth(host, () => relay.start()); proxy = new McpOAuthProxy(host, relay, oauth);
});
afterEach(async () => {
  proxy.stop(); await oauth.stop(); relay.stop(); await fixture.close();
  if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous;
  await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks();
});
async function connected() {
  const pending = await oauth.start(libraryServer.id);
  expect(pending.error).toBeNull(); expect(pending.login).not.toBeNull();
  const callback = await fixture.authorize(pending.login!.url);
  expect((await oauth.finish(libraryServer.id, callback)).connected).toBe(true);
  return callback;
}
async function call(config: Awaited<ReturnType<McpOAuthProxy["mount"]>>) {
  if (config.type === "stdio") throw new Error("Expected HTTP");
  return fetch(config.url, { method: "POST", headers: { ...config.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: {} } }) });
}

describe("MCP OAuth sign-in", () => {
  it("discovers metadata, dynamically registers, validates PKCE and stores credentials only on the host", async () => {
    const callback = await connected();
    expect(fixture.counts).toMatchObject({ registrations: 1, exchanges: 1 });
    const state = await oauth.status(libraryServer.id);
    expect(JSON.stringify(state)).not.toContain("access-"); expect(JSON.stringify(state)).not.toContain("refresh-");
    expect(JSON.stringify(await host.values())).not.toContain("access-");
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file(), "utf8")).entries[libraryServer.id].tokens.issuer).toBe(fixture.origin);
    await expect(oauth.finish(libraryServer.id, callback)).rejects.toThrow("already used");
    expect(fixture.counts.exchanges).toBe(1);
    expect(fixture.requests.find((request) => request.path === "/register")?.body).toContain('"application_type":"native"');
  });

  it.each(["state", "issuer", "missing-issuer", "path", "host", "duplicate-state"])("rejects %s without consuming a valid callback or sending its code", async (kind) => {
    const pending = await oauth.start(libraryServer.id); const valid = await fixture.authorize(pending.login!.url); const bad = new URL(valid);
    if (kind === "state") bad.searchParams.set("state", "wrong");
    if (kind === "issuer") bad.searchParams.set("iss", `${fixture.origin}/`);
    if (kind === "missing-issuer") bad.searchParams.delete("iss");
    if (kind === "path") bad.pathname = "/elsewhere";
    if (kind === "host") bad.hostname = "localhost";
    if (kind === "duplicate-state") bad.searchParams.append("state", "other");
    await expect(oauth.finish(libraryServer.id, bad.href)).rejects.toThrow(); expect(fixture.counts.exchanges).toBe(0);
    expect((await oauth.finish(libraryServer.id, valid)).connected).toBe(true);
  });

  it("preserves OIDC issuer requirements and checks present issuer even when not advertised", async () => {
    fixture.options.oidc = true;
    const pending = await oauth.start(libraryServer.id); const callback = new URL(await fixture.authorize(pending.login!.url));
    callback.searchParams.delete("iss"); await expect(oauth.finish(libraryServer.id, callback.href)).rejects.toThrow("issuer");
    fixture.options.requireIssuer = false;
    const next = await oauth.start(libraryServer.id); const valid = new URL(await fixture.authorize(next.login!.url));
    valid.searchParams.set("iss", "https://different.example"); await expect(oauth.finish(libraryServer.id, valid.href)).rejects.toThrow("issuer");
    valid.searchParams.delete("iss"); expect((await oauth.finish(libraryServer.id, valid.href)).connected).toBe(true);
  });

  it.each(["issuer", "resource", "pkce"])("rejects invalid %s metadata before exchanging credentials", async (kind) => {
    if (kind === "issuer") fixture.options.issuer = `${fixture.origin}/wrong`;
    if (kind === "resource") fixture.options.mismatchResource = true;
    if (kind === "pkce") fixture.options.pkce = false;
    const result = await oauth.start(libraryServer.id);
    expect(result.connected).toBe(false); expect(result.login).toBeNull(); expect(result.error).toBeTruthy(); expect(fixture.counts.exchanges).toBe(0);
  });

  it("supports pre-registered confidential clients without dynamic registration and never exposes their secret", async () => {
    fixture.options.dcr = false; const redirect = (await oauth.status(libraryServer.id)).redirectUrl;
    fixture.clients.set("manual-client", { redirect_uris: [redirect], client_secret: "private-manual-secret" });
    const pending = await oauth.start(libraryServer.id, { clientId: "manual-client", clientSecret: "private-manual-secret" });
    expect(pending.hasClientSecret).toBe(true); expect(JSON.stringify(pending)).not.toContain("private-manual-secret");
    expect((await oauth.finish(libraryServer.id, await fixture.authorize(pending.login!.url))).connected).toBe(true);
    expect(fixture.counts.registrations).toBe(0); expect(fixture.requests.find((request) => request.path === "/token")?.authorization).toMatch(/^Basic /);
  });

  it("bounds sign-in, cancels callbacks, hides OAuth error bodies and does not replay failed exchanges", async () => {
    const pending = await oauth.start(libraryServer.id); const callback = await fixture.authorize(pending.login!.url);
    await oauth.cancel(libraryServer.id); await expect(oauth.finish(libraryServer.id, callback)).rejects.toThrow("expired");
    const second = await oauth.start(libraryServer.id); const failed = await fixture.authorize(second.login!.url); fixture.options.denyToken = true;
    const result = await oauth.finish(libraryServer.id, failed); expect(result.error).not.toContain("code="); expect(result.connected).toBe(false);
    expect(fixture.requests.filter((request) => request.path === "/token" && request.body.includes("grant_type=authorization_code"))).toHaveLength(1);
    await expect(oauth.finish(libraryServer.id, failed)).rejects.toThrow("already used");
    fixture.options.denyToken = false; await oauth.start(libraryServer.id);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    expect((await oauth.status(libraryServer.id)).login).toBeNull();
  });

  it("does not publish credentials if disconnect races an in-flight exchange", async () => {
    const pending = await oauth.start(libraryServer.id); const callback = await fixture.authorize(pending.login!.url); fixture.options.tokenDelay = 100;
    const finish = oauth.finish(libraryServer.id, callback);
    while (!fixture.requests.some((request) => request.path === "/token")) await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([finish, oauth.disconnect(libraryServer.id)]);
    expect((await oauth.status(libraryServer.id)).connected).toBe(false);
    expect(JSON.parse(await readFile(file(), "utf8")).entries[libraryServer.id]).toBeUndefined();
  });

  it("aborts shutdown during token exchange promptly and leaves no saved token", async () => {
    const pending = await oauth.start(libraryServer.id); const callback = await fixture.authorize(pending.login!.url); fixture.options.tokenDelay = 60_000;
    const finish = oauth.finish(libraryServer.id, callback).catch((error: unknown) => error);
    while (!fixture.requests.some((request) => request.path === "/token")) await new Promise((resolve) => setTimeout(resolve, 5));
    const began = Date.now(); await oauth.stop(); await finish;
    expect(Date.now() - began).toBeLessThan(1000);
    expect(JSON.parse(await readFile(file(), "utf8")).entries[libraryServer.id].tokens).toBeUndefined();
  });

  it("discovers OAuth without waiting for an unauthenticated open SSE response to end", async () => {
    fixture.options.publicStream = true;
    libraryServer.config = { type: "sse", url: `${fixture.origin}/sse`, headers: {}, oauth: true };
    const pending = await oauth.start(libraryServer.id); expect(pending.login).not.toBeNull(); expect(pending.error).toBeNull();
  });
});

describe("OAuth proxy and persistence", () => {
  it.each(["http", "sse"] as const)("lists tools through the %s proxy with no OAuth token in provider config", async (type) => {
    libraryServer.config = { type, url: `${fixture.origin}/${type === "http" ? "mcp" : "sse"}`, headers: { authorization: "stale-custom-header" }, oauth: true };
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1");
    expect(JSON.stringify(config)).not.toContain("access-");
    expect(await probeMcpServer({ config })).toMatchObject({ ok: true, tools: [{ name: "echo" }] });
    expect(fixture.requests.filter((request) => request.path === "/mcp" || request.path === "/messages").every((request) => !request.authorization?.includes("stale-custom-header"))).toBe(true);
  });

  it("forwards SSE heartbeat/reconnect fields and Last-Event-ID while signing only the message endpoint", async () => {
    libraryServer.config = { type: "sse", url: `${fixture.origin}/sse`, headers: {}, oauth: true };
    fixture.options.ssePreamble = ": heartbeat\r\nretry: 2500\r\nid: previous\r\n\r\n";
    fixture.options.sseEndpointFields = "id: connection\nretry: 1700\n: endpoint comment\n";
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected SSE");
    const response = await fetch(config.url, { headers: { ...config.headers, "Last-Event-ID": "resume-42" } });
    const reader = response.body!.getReader(); let text = "";
    try {
      while (!text.includes("&signature=") || !text.endsWith("\n\n")) {
        const { value, done } = await reader.read(); if (done) throw new Error("SSE stream ended before its endpoint"); text += new TextDecoder().decode(value);
      }
      expect(text.startsWith(fixture.options.ssePreamble + "event: endpoint\n" + fixture.options.sseEndpointFields)).toBe(true);
      expect(text).toContain(`data: ${config.url}?endpoint=`);
      expect(text).toContain("&signature=");
      expect(fixture.requests.find((request) => request.path === "/sse" && request.lastEventId)?.lastEventId).toBe("resume-42");
    } finally { await reader.cancel(); }
  });

  it("coalesces parallel 401 refreshes, rotates tokens and retries unauthorized requests once", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); fixture.accessTokens.clear();
    const responses = await Promise.all([call(config), call(config), call(config)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]); expect(fixture.counts.refreshes).toBe(1); expect(fixture.counts.calls).toBe(3);
    fixture.options.alwaysUnauthorized = true;
    expect((await call(config)).status).toBe(401); expect(fixture.counts.refreshes).toBe(2); expect(fixture.counts.calls).toBe(3);
  });

  it("restores durable credentials after reload and keeps omitted refresh tokens", async () => {
    await connected(); const first = await oauth.accessToken(libraryServer.id);
    await oauth.stop(); oauth = new McpOAuth(host, () => relay.start());
    expect(await oauth.accessToken(libraryServer.id)).toBe(first);
    fixture.options.omitRefreshOnRefresh = true;
    const second = await oauth.accessToken(libraryServer.id, first); expect(second).not.toBe(first);
    await expect(oauth.accessToken(libraryServer.id, second)).resolves.not.toBe(second);
  });

  it("disconnect revokes existing proxy credentials; removed/disabled/unassigned servers cannot forward", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1");
    libraryServer.enabled = false; expect((await call(config)).status).toBe(403); libraryServer.enabled = true;
    (await host.values())!.bots[0]!.mcpServerIds = []; expect((await call(config)).status).toBe(403);
    (await host.values())!.bots[0]!.mcpServerIds = [libraryServer.id]; await oauth.disconnect(libraryServer.id);
    expect((await call(config)).status).toBe(401); expect(fixture.counts.calls).toBe(0);
  });

  it("never follows MCP redirects carrying OAuth credentials", async () => {
    await connected(); fixture.options.redirect = true; const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1");
    expect((await call(config)).status).toBe(502); expect(fixture.requests.some((request) => request.path === "/stolen")).toBe(false);
  });

  it("invalidates changed configuration and never falls back to sending an OAuth server directly", async () => {
    await connected(); libraryServer.config = { type: "http", url: `${fixture.origin}/changed`, headers: {}, oauth: true };
    expect((await oauth.status(libraryServer.id)).connected).toBe(false); await expect(oauth.accessToken(libraryServer.id)).rejects.toThrow("Connect");
    const values = (await host.values())!; expect(buildAgentConfig(values.bots[0]!, values.library!, "model", "").mcpServers).toBeUndefined();
  });

  it("does not send a new connection's token to an old target when a POST pauses across configuration changes", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected HTTP");
    const seenBot = vi.spyOn(host, "bot");
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<number | string>((resolve) => {
      request = httpRequest(config.url, { method: "POST", headers: { ...config.headers, "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "closed")); request.write('{"jsonrpc":"2.0",');
    });
    while (!seenBot.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = await oauthFixture();
    try {
      libraryServer.config = { type: "http", url: `${other.origin}/mcp`, headers: {}, oauth: true };
      const pending = await oauth.start(libraryServer.id); expect((await oauth.finish(libraryServer.id, await other.authorize(pending.login!.url))).connected).toBe(true);
      request.end('"id":7,"method":"tools/call","params":{"name":"echo"}}');
      expect([401, "ECONNRESET"]).toContain(await result); expect(fixture.counts.calls).toBe(0); expect(other.counts.calls).toBe(0);
      const newTokens = other.accessTokens;
      expect(fixture.requests.every((entry) => !newTokens.has(entry.authorization?.replace(/^Bearer /, "") ?? ""))).toBe(true);
    } finally { request.destroy(); await other.close(); }
  });

  it("closes a partially uploaded proxy request on shutdown", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected HTTP");
    const seenBot = vi.spyOn(host, "bot");
    const request = httpRequest(config.url, { method: "POST", headers: config.headers });
    const closed = new Promise<void>((resolve) => { request.on("error", () => {}); request.on("close", resolve); });
    request.write('{"partial":');
    while (!seenBot.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 10));
    proxy.stop(); await closed;
    expect(fixture.counts.calls).toBe(0);
  });

  it.each(["disabled", "unassigned", "archived"])("rechecks %s access after reading a paused POST body", async (kind) => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected HTTP");
    const seenBot = vi.spyOn(host, "bot");
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<number>((resolve, reject) => {
      request = httpRequest(config.url, { method: "POST", headers: config.headers }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.write('{"jsonrpc":"2.0",');
    });
    while (!seenBot.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const bot = (await host.values())!.bots[0]!;
    if (kind === "disabled") libraryServer.enabled = false;
    if (kind === "unassigned") bot.mcpServerIds = [];
    if (kind === "archived") bot.archived = true;
    request.end('"id":7,"method":"tools/call","params":{"name":"echo"}}');
    expect(await result).toBe(401); expect(fixture.counts.calls).toBe(0);
  });

  it("disconnect closes an existing SSE stream and does not recreate an empty credential record", async () => {
    libraryServer.config = { type: "sse", url: `${fixture.origin}/sse`, headers: {}, oauth: true };
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected SSE");
    const response = await fetch(config.url, { headers: config.headers }); const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await oauth.disconnect(libraryServer.id);
    await expect(reader.read()).rejects.toThrow();
    expect(await oauth.verifyProxyToken(libraryServer.id, JSON.stringify(["bot-1", "agent-1"]), config.headers.Authorization)).toBe(false);
    expect(JSON.parse(await readFile(file(), "utf8")).entries[libraryServer.id]).toBeUndefined();
  });

  it("never recreates disconnected credentials or signs an endpoint with a reconnected generation", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio" || libraryServer.config.type === "stdio") throw new Error("Expected HTTP");
    const subject = JSON.stringify(["bot-1", "agent-1"]); const endpoint = `${fixture.origin}/messages`;
    await oauth.disconnect(libraryServer.id);
    await expect(oauth.proxyEndpointToken(libraryServer.id, subject, endpoint, config.headers.Authorization, libraryServer.config)).rejects.toThrow("changed");
    expect(JSON.parse(await readFile(file(), "utf8")).entries[libraryServer.id]).toBeUndefined();
    await connected();
    await expect(oauth.proxyEndpointToken(libraryServer.id, subject, endpoint, config.headers.Authorization, libraryServer.config)).rejects.toThrow("changed");
    const current = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (current.type === "stdio") throw new Error("Expected HTTP");
    const token = await oauth.proxyEndpointToken(libraryServer.id, subject, endpoint, current.headers.Authorization, libraryServer.config);
    expect(await oauth.verifyProxyToken(libraryServer.id, `${subject}:${endpoint}`, `Bearer ${token}`)).toBe(true);
  });

  it("does not start the relay when status or a verified request resumes after shutdown", async () => {
    await connected(); const config = await proxy.mount(libraryServer.id, "bot-1", "agent-1"); if (config.type === "stdio") throw new Error("Expected HTTP");
    const start = vi.spyOn(relay, "start"); start.mockClear();
    const originalVerify = oauth.verifyProxyToken.bind(oauth);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const verify = vi.spyOn(oauth, "verifyProxyToken").mockImplementation(async (...args) => { await paused; return originalVerify(...args); });
    const response = call(config);
    while (!verify.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const originalValues = host.values.bind(host);
    const values = vi.spyOn(host, "values").mockImplementation(async () => { await paused; return (await originalValues())!; });
    const status = oauth.status(libraryServer.id).catch((error: unknown) => error);
    while (!values.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    proxy.stop(); await oauth.stop(); relay.stop(); resume();
    expect((await response).status).toBe(503);
    expect(await status).toBeInstanceOf(Error);
    await expect(proxy.mount(libraryServer.id, "bot-1", "agent-1")).rejects.toThrow("stopping");
    expect(start).not.toHaveBeenCalled();
    expect(fixture.counts.calls).toBe(0);
  });

  it("does not persist status-only records and frees capacity when servers are removed or disconnected", async () => {
    await oauth.status(libraryServer.id); await expect(stat(file())).rejects.toMatchObject({ code: "ENOENT" });
    await connected(); const store = JSON.parse(await readFile(file(), "utf8"));
    for (let i = 0; i < 199; i++) store.entries[`removed-${i}`] = { ...store.entries[libraryServer.id] };
    await writeFile(file(), JSON.stringify(store)); await oauth.proxyToken(libraryServer.id, "test");
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).entries)).toEqual([libraryServer.id]);
    await oauth.disconnect(libraryServer.id); expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).entries)).toEqual([]);
  });

  it("fails closed for corrupt, oversized and symlink credential storage", async () => {
    await connected(); await writeFile(file(), "x".repeat(1024 * 1024 + 1)); await expect(oauth.status(libraryServer.id)).rejects.toThrow("limit");
    await writeFile(file(), "broken"); await expect(oauth.status(libraryServer.id)).rejects.toThrow();
    await rm(file()); const target = join(directory, "secret-target"); await writeFile(target, "untouched"); await symlink(target, file());
    await expect(oauth.start(libraryServer.id)).rejects.toThrow(); expect(await readFile(target, "utf8")).toBe("untouched");
  });
});

describe("public Paseo launch and permission hooks", () => {
  it("injects OAuth only at session open, keeps unrelated contributions, and avoids saved-name collisions", async () => {
    const hooks = new Map<string, (...args: never[]) => Promise<unknown>>();
    registerMcpOAuthLifecycle({ addHook: (name: string, handler: (...args: never[]) => Promise<unknown>) => { hooks.set(name, handler); } } as never, host, proxy);
    const bot = (await host.values())!.bots[0]!;
    const saved = buildAgentConfig(bot, (await host.values())!.library!, "model", "");
    expect(saved.mcpServers).toBeUndefined();
    const request = { agentId: "agent-1", labels: { "paseo-bots.bot": bot.id }, purpose: "interactive", mcpServers: { other: { type: "http", url: "https://other.example/mcp" } } } as unknown as PluginSessionOpenRequest;
    const open = hooks.get("agent.open.before")! as (event: { request: PluginSessionOpenRequest }, context: { paseo: unknown }) => Promise<PluginSessionOpenRequest | undefined>;
    const result = await open({ request }, { paseo: {} });
    expect(Object.keys(result!.mcpServers)).toEqual(["other", "fixture"]);
    expect(result!.mcpServers.fixture).toMatchObject({ type: "http", url: expect.stringContaining("/mcp-oauth/proxy/") });
    expect(request.mcpServers).not.toHaveProperty("fixture");
    await expect(open({ request: { ...request, mcpServers: { fixture: request.mcpServers.other! } } }, { paseo: {} })).rejects.toThrow("conflicts with another plugin");
    expect(await open({ request: { ...request, purpose: "history" } }, { paseo: {} })).toBeUndefined();
    libraryServer.enabled = false;
    expect((await open({ request }, { paseo: {} }))!.mcpServers).not.toHaveProperty("fixture");
  });

  it("honors only exact Claude grants for currently enabled assigned OAuth servers", async () => {
    const values = (await host.values())!; const bot = values.bots[0]!; bot.alwaysAllow = ["fixture/echo"];
    const request = { provider: "claude", kind: "tool", name: "mcp__fixture__echo" } as PluginHookEvents["agent.permission.before"]["request"];
    expect(allowsOAuthTool(bot, values.library!, request)).toBe(true);
    expect(allowsOAuthTool(bot, values.library!, { ...request, name: "mcp__fixture__delete" })).toBe(false);
    expect(allowsOAuthTool(bot, values.library!, { ...request, provider: "codex", name: "CodexMcpElicitation" })).toBe(false);
    bot.alwaysAllow.push("fixture/sub__tool");
    expect(allowsOAuthTool(bot, values.library!, { ...request, name: "mcp__fixture__sub__tool" })).toBe(false);
    expect(allowsOAuthTool(bot, values.library!, { ...request, kind: "question" } as never)).toBe(false);
    libraryServer.enabled = false; expect(allowsOAuthTool(bot, values.library!, request)).toBe(false); libraryServer.enabled = true;
    bot.mcpServerIds = []; expect(allowsOAuthTool(bot, values.library!, request)).toBe(false);
  });
});
