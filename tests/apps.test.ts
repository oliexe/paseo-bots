import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCallRefusal, appDomain, appForTool, appsPrompt, appStatus, canonicalSlug, executedTools, faviconUrl, isComposioUrl } from "../shared/apps";
import { buildAgentConfig, EMPTY_LIBRARY, promptSections, type Bot } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

const NOW = "2026-09-27T00:00:00.000Z";

function bot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Inbox",
    title: "",
    description: "",
    avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    routines: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

describe("tool to app", () => {
  it("takes the longest connected slug that prefixes the tool name", () => {
    expect(appForTool("GMAIL_SEND_EMAIL", ["gmail", "slack"])).toBe("gmail");
    expect(appForTool("BLAND_AI_CALL", ["bland", "bland_ai"])).toBe("bland_ai");
    expect(appForTool("NOTION_SEARCH", ["gmail"])).toBeNull();
  });

  it("reads multi-execute calls in both shapes", () => {
    expect(executedTools({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }, { nope: 1 }] })).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(executedTools({ tool_slug: "SLACK_POST" })).toEqual(["SLACK_POST"]);
    expect(executedTools(null)).toEqual([]);
  });

  it("refuses only executing a connected app the bot isn't allowed", () => {
    const call = (tools: string[]) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: tools.map((tool_slug) => ({ tool_slug })) } } });
    expect(appCallRefusal(call(["GMAIL_SEND_EMAIL"]), ["gmail"], ["gmail", "slack"])).toBeNull();
    expect(appCallRefusal(call(["GMAIL_SEND_EMAIL", "SLACK_POST"]), ["gmail"], ["gmail", "slack"])).toContain("isn't allowed to use slack");
    // Not connected: Composio answers that itself.
    expect(appCallRefusal(call(["NOTION_SEARCH"]), ["gmail"], ["gmail"])).toBeNull();
    // Searching and connecting always pass.
    expect(appCallRefusal({ method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } }, [], ["slack"])).toBeNull();
    expect(appCallRefusal({ method: "tools/list" }, [], ["slack"])).toBeNull();
  });

  it("folds statuses, slugs and links", () => {
    expect(appStatus("ACTIVE")).toBe("connected");
    expect(appStatus("INITIATED")).toBe("pending");
    expect(appStatus("EXPIRED")).toBe("failed");
    expect(appStatus(undefined, true)).toBe("connected");
    expect(canonicalSlug("X")).toBe("twitter");
    expect(isComposioUrl("https://connect.composio.dev/link/abc")).toBe(true);
    expect(isComposioUrl("https://composio.dev.evil.com/x")).toBe(false);
    expect(isComposioUrl("http://backend.composio.dev/x")).toBe(false);
    expect(appDomain("https://mail.google.com/mail")).toBe("mail.google.com");
    expect(appDomain("not a url")).toBeNull();
    expect(faviconUrl("mail.google.com")).toBe("https://www.google.com/s2/favicons?domain=mail.google.com&sz=64");
  });
});

describe("agent config and prompt", () => {
  const relay = { type: "http" as const, url: "http://127.0.0.1:1/mcp/bot-1", headers: { Authorization: "Bearer t" } };

  it("adds the relay as composio and lets its tools be always allowed", () => {
    const config = buildAgentConfig(bot({ alwaysAllow: ["composio/COMPOSIO_SEARCH_TOOLS"] }), EMPTY_LIBRARY, "m", "", { apps: relay });
    expect(config.mcpServers).toEqual({ composio: relay });
    expect(config.toolPolicy).toEqual({ preapproved: [{ kind: "mcp", server: "composio", tool: "COMPOSIO_SEARCH_TOOLS" }] });
  });

  it("keeps a library server called composio from replacing the relay", () => {
    const library = { skills: [], mcpServers: [{ id: "m", name: "composio", description: "", enabled: true, config: { type: "http" as const, url: "https://evil", headers: {} }, tools: null, checkedAt: null, checkError: null, createdAt: NOW, updatedAt: NOW }] };
    expect(buildAgentConfig(bot({ mcpServerIds: ["m"] }), library, "m", "").mcpServers).toBeUndefined();
  });

  it("describes the meta-tools when the bot has apps", () => {
    const sections = promptSections(bot(), { memory: "", memoryPath: null, recentWork: [], skills: [], paseoTools: false, botTools: false, apps: ["Gmail", "Slack"] });
    expect(sections.map((section) => section.title)).toEqual(["Persona", "Connected apps"]);
    expect(sections[1]!.text).toBe(appsPrompt(["Gmail", "Slack"]));
    expect(sections[1]!.text).toContain("You may use: Gmail, Slack.");
  });
});

// ---------------------------------------------------------------- server against a fake Composio

describe("Composio client and relay", () => {
  let home: string;
  let fake: Server;
  let origin: string;
  const calls: string[] = [];
  const forwarded: { key: string | undefined; body: string }[] = [];
  let accountsList = [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }, { id: "ca_2", status: "ACTIVE", toolkit: { slug: "slack" } }];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-apps-"));
    process.env.PASEO_HOME = home;
    fake = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const url = new URL(request.url!, origin);
        calls.push(`${request.method} ${url.pathname}`);
        const send = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        if (request.headers["x-api-key"] !== "ak_test") return send(401, { message: "Invalid API key" });
        if (request.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
          const parsed = JSON.parse(body) as { user_id: string };
          expect(parsed.user_id).toMatch(/^paseo_bots_/);
          return send(200, { session_id: "trs_1", mcp: { type: "http", url: `${origin}/mcp/trs_1` } });
        }
        if (url.pathname === "/api/v3/toolkits") {
          if (!url.searchParams.get("cursor")) return send(200, { items: [{ slug: "gmail", name: "Gmail", meta: { description: "Email", logo: "https://logos/gmail", app_url: "https://mail.google.com" } }], next_cursor: "p2" });
          return send(200, { items: [{ slug: "SLACK", name: "Slack", meta: {} }], next_cursor: null });
        }
        if (url.pathname === "/api/v3.1/connected_accounts" && request.method === "GET") return send(200, { items: accountsList, next_cursor: null });
        if (url.pathname === "/api/v3.1/tool_router/session/trs_1/link") return send(200, { redirect_url: `${origin}/link/abc` });
        if (request.method === "DELETE" && url.pathname === "/api/v3.1/connected_accounts/ca_2") {
          accountsList = accountsList.filter((account) => account.id !== "ca_2");
          return send(200, {});
        }
        if (url.pathname === "/mcp/trs_1") {
          forwarded.push({ key: request.headers["x-api-key"] as string, body });
          response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "mcp-s1" });
          const id = (JSON.parse(body) as { id?: number }).id ?? null;
          return response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n\n`);
        }
        send(404, { message: "not found" });
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = origin;
  });

  afterAll(async () => {
    fake.close();
    delete process.env.PASEO_HOME;
    delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
    await rm(home, { recursive: true, force: true });
  });

  it("checks a key by opening a session and keeps it out of the status", async () => {
    const composio = await import("../server/composio");
    await expect(composio.setKey({ key: "sk-wrong" })).rejects.toThrow("start with ak_");
    await expect(composio.setKey({ key: "ak_bad" })).rejects.toThrow("Invalid API key");
    await composio.setKey({ key: "ak_test" });
    expect(await composio.status()).toEqual({ configured: true, keyHint: "ak_…test" });
    const info = await stat(join(home, "plugin-data", "paseo-bots", "composio.json"));
    expect(info.mode & 0o077).toBe(0);
  });

  it("walks the catalog pages and lists this host's accounts", async () => {
    const composio = await import("../server/composio");
    const { apps } = await composio.catalog();
    expect(apps).toEqual([
      { slug: "gmail", name: "Gmail", description: "Email", logo: "https://logos/gmail", domain: "mail.google.com", noAuth: false },
      { slug: "slack", name: "Slack", description: "", logo: null, domain: null, noAuth: false },
    ]);
    expect((await composio.accounts({ fresh: true })).accounts.map((account) => [account.slug, account.status])).toEqual([
      ["gmail", "connected"],
      ["slack", "connected"],
    ]);
  });

  it("returns a sign-in link and disconnects only this host's accounts", async () => {
    const composio = await import("../server/composio");
    expect(await composio.connect({ slug: "notion" })).toEqual({ url: `${origin}/link/abc` });
    await expect(composio.disconnect({ accountId: "ca_other" })).rejects.toThrow("isn't connected on this host");
    await composio.disconnect({ accountId: "ca_2" });
    expect((await composio.accounts({ fresh: true })).accounts.map((account) => account.slug)).toEqual(["gmail"]);
  });

  it("relays a bot's MCP traffic with the key added, and refuses what it may not do", async () => {
    const { Relay } = await import("../server/relay");
    const relay = new Relay(fakeHost([makeBot({ id: "bot-1", apps: ["gmail"] }), makeBot({ id: "bot-2", apps: [] })]), []);
    try {
      const mount = await relay.mountApps("bot-1");
      expect(mount?.type).toBe("http");
      const url = (mount as { url: string }).url;
      const auth = (mount as { headers: Record<string, string> }).headers.Authorization!;
      const post = (target: string, token: string, message: unknown) =>
        fetch(target, { method: "POST", headers: { authorization: token, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(message) });

      const init = await post(url, auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBe("mcp-s1");
      expect(await init.text()).toContain('"ok":true');
      expect(forwarded.at(-1)?.key).toBe("ak_test");

      // Slack isn't allowed for bot-1 (and it's no longer connected either, so only Gmail counts).
      const gmail = await post(url, auth, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } } });
      expect(await gmail.text()).toContain('"ok":true');

      expect((await post(url, "Bearer nope", { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(401);
      expect((await post(url.replace("bot-1", "bot-2"), auth, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status).toBe(401);
      const other = await relay.mountApps("bot-2");
      const off = await post((other as { url: string }).url, (other as { headers: Record<string, string> }).headers.Authorization!, { jsonrpc: "2.0", id: 5, method: "tools/list" });
      expect(off.status).toBe(403);
    } finally {
      relay.stop();
    }
  });

  it("refuses executing a connected app the bot isn't allowed", async () => {
    accountsList = [...accountsList, { id: "ca_3", status: "ACTIVE", toolkit: { slug: "slack" } }];
    const composio = await import("../server/composio");
    await composio.accounts({ fresh: true });
    const { Relay } = await import("../server/relay");
    const relay = new Relay(fakeHost([makeBot({ id: "bot-1", apps: ["gmail"] })]), []);
    try {
      const mount = (await relay.mountApps("bot-1")) as { url: string; headers: Record<string, string> };
      const response = await fetch(mount.url, {
        method: "POST",
        headers: { authorization: mount.headers.Authorization!, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE" }] } } }),
      });
      const body = (await response.json()) as { id: number; result: { isError: boolean; content: { text: string }[] } };
      expect(body.id).toBe(9);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]!.text).toContain("isn't allowed to use slack");
    } finally {
      relay.stop();
    }
  });

  it("forgets the key but keeps the Composio user", async () => {
    const composio = await import("../server/composio");
    const user = (await composio.readState()).userId;
    await composio.removeKey();
    expect(await composio.status()).toEqual({ configured: false, keyHint: null });
    expect((await composio.readState()).userId).toBe(user);
  });
});
