import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentConfig, EMPTY_LIBRARY } from "../shared/bot";
import { botToolName, supportsToolGrants } from "../shared/bot-tools";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot } from "./helpers";

describe("tool names and grants", () => {
  it("recognises the plugin's tools whatever the provider calls them", () => {
    expect(botToolName("mcp__bots__ask_bot")).toBe("ask_bot");
    expect(botToolName("bots.propose_skill")).toBe("propose_skill");
    expect(botToolName("bots_list_bots")).toBe("list_bots");
    expect(botToolName("mcp__other__ask_bot")).toBeNull();
    expect(botToolName("bots.unknown")).toBeNull();
  });

  it("only sends grants to providers that take exact grants", () => {
    expect(supportsToolGrants("claude")).toBe(true);
    expect(supportsToolGrants("opencode")).toBe(true);
    expect(supportsToolGrants("gemini")).toBe(false);
    const tools = { type: "http" as const, url: "http://127.0.0.1:1/bots/b/a", headers: {} };
    const claude = buildAgentConfig(makeBot({ alwaysAllow: ["bots/ask_bot"] }), EMPTY_LIBRARY, "m", "", { tools });
    expect(claude.mcpServers).toEqual({ bots: tools });
    expect(claude.toolPolicy?.preapproved.map((grant) => grant.tool)).toEqual(["list_bots", "check_chat", "search_chats", "propose_skill", "propose_routine", "connect_app", "ask_bot"]);
    // Paseo refuses a chat whose provider can't take grants, so none are sent.
    expect(buildAgentConfig(makeBot({ provider: "gemini", alwaysAllow: ["bots/ask_bot"] }), EMPTY_LIBRARY, "m", "", { tools })).not.toHaveProperty("toolPolicy");
  });

  it("makes v4 UUIDs for agent ids", () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("the bots MCP server", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-tools-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("serves the MCP handshake, lists its tools and runs them for one chat", async () => {
    const { Relay } = await import("../server/relay");
    const { BOT_TOOLS } = await import("../server/tools");
    const host = fakeHost([makeBot({ id: "bot-a", name: "Scout", title: "Researcher" }), makeBot({ id: "bot-b", name: "Inbox", description: "Email triage" }), makeBot({ id: "bot-c", archived: true })]);
    const relay = new Relay(host, BOT_TOOLS);
    try {
      const agentId = newUuid();
      const mount = (await relay.mountTools("bot-a", agentId)) as { url: string; headers: Record<string, string> };
      expect(mount.url).toContain(`/bots/bot-a/${agentId}`);
      const post = (body: unknown, token = mount.headers.Authorization!, url = mount.url) =>
        fetch(url, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });

      const init = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("paseo-bots");
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
      expect(list.result.tools.map((tool) => tool.name)).toContain("list_bots");
      expect(list.result.tools[0]!.inputSchema.type).toBe("object");

      const call = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } })).json()) as { result: { content: { text: string }[] } };
      expect(call.result.content[0]!.text).toBe("- Inbox (id: bot-b): Email triage");

      // A token for another chat, or another bot's URL, is refused.
      expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "Bearer nope")).status).toBe(401);
      expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, mount.headers.Authorization!, mount.url.replace(agentId, newUuid()))).status).toBe(401);
      const unknown = (await (await post({ jsonrpc: "2.0", id: 6, method: "nope" })).json()) as { error: { code: number } };
      expect(unknown.error.code).toBe(-32601);
    } finally {
      relay.stop();
    }
  });
});
