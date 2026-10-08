import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentConfig, EMPTY_LIBRARY } from "../shared/bot";
import { botToolName, supportsToolGrants } from "../shared/bot-tools";
import { withPluginCommands } from "../client/chat/composer/logic";
import { proposalIdOf } from "../shared/proposals";
import { permissionInput, permissionToolName } from "../shared/tool-name";
import { expandLearn, sanitizeSkillName } from "../shared/skills";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot } from "./helpers";

describe("tool names and grants", () => {
  it("recognises the plugin's tools whatever the provider calls them", () => {
    expect(botToolName("mcp__bots__ask_bot")).toBe("ask_bot");
    expect(botToolName("bots.propose_skill")).toBe("propose_skill");
    expect(botToolName("bots_list_bots")).toBe("list_bots");
    expect(botToolName("bots / propose_changes")).toBe("propose_changes");
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
    expect(claude.toolPolicy?.preapproved.map((grant) => grant.tool)).toEqual(["list_bots", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app", "ask_bot"]);
    // Paseo refuses a chat whose provider can't take grants, so none are sent.
    expect(buildAgentConfig(makeBot({ provider: "gemini", alwaysAllow: ["bots/ask_bot"] }), EMPTY_LIBRARY, "m", "", { tools })).not.toHaveProperty("toolPolicy");
  });

  it("expands /learn and lists it before provider commands", () => {
    expect(expandLearn("/learn")).toContain("propose_skill");
    expect(expandLearn("  /learn the invoice part ")).toContain("Focus on: the invoice part.");
    expect(expandLearn("/learner")).toBeNull();
    expect(expandLearn("please /learn")).toBeNull();
    const learn = { name: "learn", description: "ours", argumentHint: "" };
    const provider = [{ name: "learn", description: "theirs", argumentHint: "" }, { name: "compact", description: "", argumentHint: "" }];
    expect(withPluginCommands([learn], provider).map((command) => command.description)).toEqual(["ours", ""]);
  });

  it("finds the proposal behind a finished propose_skill call", () => {
    const output = [{ type: "text", text: "Proposal p-0123456789: the user sees..." }];
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "completed", detail: { type: "unknown", input: {}, output } })).toBe("p-0123456789");
    expect(proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { type: "unknown", input: {}, output: "Proposal p-abcdefabcd: x" } })).toBe("p-abcdefabcd");
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "running", detail: { type: "unknown", input: {}, output: null } })).toBeNull();
    expect(proposalIdOf({ name: "mcp__bots__list_bots", status: "completed", detail: { type: "unknown", input: {}, output } })).toBeNull();
  });

  it("finds the proposal behind an ACP provider's call, which Paseo names by its kind", () => {
    const detail = { type: "unknown", input: {}, output: "Proposal p-0123456789: the user sees..." };
    const acp = (title: string, kind: string | null = "other") => ({ name: kind ?? title, status: "completed", detail, metadata: { ...(kind ? { kind } : {}), title } });
    expect(proposalIdOf(acp("mcp__bots__propose_changes: Add a Researcher bot"))).toBe("p-0123456789");
    expect(proposalIdOf(acp("mcp__bots__propose_changes"))).toBe("p-0123456789");
    expect(proposalIdOf(acp("mcp__bots__propose_skill: invoices: march", null))).toBe("p-0123456789");
    expect(proposalIdOf(acp("mcp__bots__get_setup"))).toBeNull();
    expect(proposalIdOf(acp("Propose changes to the setup"))).toBeNull();
    // A provider's own name wins over a title it didn't derive the name from.
    expect(proposalIdOf({ name: "Bash", status: "completed", detail, metadata: { title: "mcp__bots__propose_changes" } })).toBeNull();
  });

  it("reads the tool and arguments of an ACP provider's permission request from its title and raw request", () => {
    const rawRequest = { sessionId: "s", toolCall: { toolCallId: "tc-1", title: "mcp__bots__ask_bot: Helper", rawInput: { bot: "Helper" } }, options: [] };
    const acp = { name: "other", title: "mcp__bots__ask_bot: Helper", metadata: { toolCallId: "tc-1", rawRequest } };
    expect(permissionToolName(acp)).toBe("mcp__bots__ask_bot");
    expect(permissionInput(acp)).toEqual({ bot: "Helper" });
    const claude = { name: "mcp__bots__ask_bot", title: "Ask a bot", input: { bot: "Writer" } };
    expect(permissionToolName(claude)).toBe("mcp__bots__ask_bot");
    expect(permissionInput(claude)).toEqual({ bot: "Writer" });
    expect(permissionToolName({ name: "CodexMcpElicitation", title: "MCP approval: bots" })).toBe("CodexMcpElicitation");
  });

  it("keeps skill folder names inside the library", () => {
    expect(sanitizeSkillName("..")).toBe("skill");
    expect(sanitizeSkillName(".hidden.")).toBe("hidden");
    expect(sanitizeSkillName("v1.2 notes")).toBe("v1.2-notes");
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

  it("proposes a skill that the user saves or dismisses once", async () => {
    const { proposeSkill } = await import("../server/tools/skills");
    const { acceptProposal, dismissProposal, getProposal } = await import("../server/proposals");
    const { librarySkillPath } = await import("../server/library");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: newUuid(), host, relay: null as never };
    const reply = await proposeSkill.run({ name: "Weekly Report!", description: "Use for the\nweekly report", instructions: "1. Collect PRs." }, caller);
    const id = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: reply } })!;
    expect(id).toMatch(/^p-[a-z0-9]{10}$/);

    const proposal = await getProposal(id);
    expect(proposal).toMatchObject({ botId: "bot-a", agentId: caller.agentId, kind: "skill", status: "pending", data: { name: "weekly-report", description: "Use for the weekly report" } });
    expect(proposal!.kind === "skill" && proposal!.data.text).toBe("---\nname: weekly-report\ndescription: Use for the weekly report\n---\n\n1. Collect PRs.\n");

    const accepted = await acceptProposal(id);
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.skill).toMatchObject({ id: "weekly-report", description: "Use for the weekly report" });
    expect(await readFile(join(librarySkillPath("weekly-report"), "SKILL.md"), "utf8")).toBe(proposal!.kind === "skill" ? proposal!.data.text : "");
    await expect(acceptProposal(id)).rejects.toThrow("already saved");
    await expect(dismissProposal(id)).rejects.toThrow("already saved");

    const other = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: await proposeSkill.run({ name: "x", description: "y", instructions: "z" }, caller) } })!;
    expect((await dismissProposal(other)).status).toBe("dismissed");
    await expect(acceptProposal(other)).rejects.toThrow("dismissed");
    await expect(acceptProposal("p-0000000000")).rejects.toThrow("no longer available");
  });
});
