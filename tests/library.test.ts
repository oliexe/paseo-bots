import { createServer } from "node:http";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type Bot, type BotMcpServer, type Library } from "../shared/bot";
import { addMcpServers, forgetItem, matchesQuery, mcpTarget, renameGrants, setBotUses, upsertSkills } from "../shared/library";

const NOW = "2026-09-27T00:00:00.000Z";

function bot(id: string, patch: Partial<Bot> = {}): Bot {
  return {
    id,
    name: id,
    title: "",
    description: "",
    avatar: { seed: id, palette: null, shape: "circle", imageUrl: null },
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
    contactBots: "ask",
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const fetchConfig = { type: "stdio" as const, command: "uvx", args: ["mcp-server-fetch"], env: {} };
const fetchDraft: BotMcpServer = { name: "fetch", enabled: true, config: fetchConfig };

describe("addMcpServers", () => {
  it("reuses an identical server and renames a clashing one", () => {
    const first = addMcpServers(EMPTY_LIBRARY, [fetchDraft], { now: NOW });
    const again = addMcpServers(first.library, [fetchDraft, { ...fetchDraft, config: { ...fetchConfig, args: ["other"] } }], { now: NOW });
    expect(again.ids[0]).toBe(first.ids[0]);
    expect(again.library.mcpServers.map((server) => server.name)).toEqual(["fetch", "fetch-2"]);
  });

  it("reuses any server of the same name for templates and imports", () => {
    const first = addMcpServers(EMPTY_LIBRARY, [fetchDraft], { now: NOW });
    const redacted = { ...fetchDraft, config: { ...fetchConfig, env: { KEY: "<redacted>" } } };
    const again = addMcpServers(first.library, [redacted], { reuseByName: true });
    expect(again.ids).toEqual(first.ids);
    expect(again.library.mcpServers).toHaveLength(1);
  });

  it("keeps a template's switched-off server off", () => {
    const { library } = addMcpServers(EMPTY_LIBRARY, [{ ...fetchDraft, enabled: false }]);
    expect(library.mcpServers[0]!.enabled).toBe(false);
  });
});

describe("upsertSkills", () => {
  it("adds fetched skills switched off and unreviewed, and a refresh needs a new review", () => {
    const library: Library = { ...EMPTY_LIBRARY, skills: [{ id: "pdf", description: "old", source: "a", enabled: true, reviewedSha: "abc", createdAt: NOW, updatedAt: NOW }] };
    const next = upsertSkills(library, [
      { id: "pdf", description: "new", source: "" },
      { id: "docx", description: "Word", source: "b" },
    ]);
    expect(next.skills.map((skill) => [skill.id, skill.description, skill.source, skill.enabled, skill.reviewedSha, skill.createdAt === NOW])).toEqual([
      ["pdf", "new", "a", true, null, true],
      ["docx", "Word", "b", false, null, false],
    ]);
  });

  it("switches on a skill written here, reviewed as written", () => {
    const next = upsertSkills(EMPTY_LIBRARY, [{ id: "mine", description: "d", source: "", reviewedSha: "f00" }]);
    expect(next.skills[0]).toMatchObject({ enabled: true, reviewedSha: "f00" });
  });
});

describe("bot references", () => {
  it("switches items on and off per bot and forgets deleted ones", () => {
    const a = setBotUses(bot("a"), "skill", "pdf", true);
    expect(setBotUses(a, "skill", "pdf", true)).toBe(a);
    expect(a.skillIds).toEqual(["pdf"]);
    const b = setBotUses(bot("b"), "mcp", "m1", true);
    expect(forgetItem([a, b], "skill", "pdf").map((entry) => entry.skillIds)).toEqual([[], []]);
  });

  it("rewrites always-allowed grants when a server is renamed", () => {
    const [renamed, untouched] = renameGrants([bot("a", { alwaysAllow: ["fetch/get", "fetcher/x"] }), bot("b")], "fetch", "web");
    expect(renamed!.alwaysAllow).toEqual(["web/get", "fetcher/x"]);
    expect(untouched!.alwaysAllow).toEqual([]);
  });
});

describe("display helpers", () => {
  it("describes a connection and matches searches", () => {
    expect(mcpTarget(fetchDraft.config)).toBe("uvx mcp-server-fetch");
    expect(mcpTarget({ type: "sse", url: "https://x/sse", headers: {} })).toBe("SSE · https://x/sse");
    expect(matchesQuery("FET", "fetch")).toBe(true);
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("zz", "fetch", null)).toBe(false);
  });
});

// ---------------------------------------------------------------- server

describe("server library", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-lib-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("moves the old paseo-bot data folder to the new name and links it", async () => {
    const { migrateRenamedPluginData, pluginDataPath } = await import("../server/bot-home");
    const { mkdir, readlink, readFile } = await import("node:fs/promises");
    const legacy = join(home, "plugin-data", "paseo-bot");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "composio.json"), "{}");
    migrateRenamedPluginData();
    expect(await readFile(join(pluginDataPath(), "composio.json"), "utf8")).toBe("{}");
    expect(await readlink(legacy)).toBe(pluginDataPath());
    // Running it again leaves everything as it is.
    migrateRenamedPluginData();
    expect(await readlink(legacy)).toBe(pluginDataPath());
  });

  it("only gives bots skills whose SKILL.md is what the user reviewed", async () => {
    const { writeSkill, sha256 } = await import("../server/library");
    const { promptContext } = await import("../server/prompt");
    const text = "---\nname: gated\ndescription: G\n---\nBody\n";
    await writeSkill({ id: "gated", text });
    const skill = (reviewedSha: string | null | undefined) => ({ id: "gated", description: "G", source: "", enabled: true, reviewedSha, createdAt: NOW, updatedAt: NOW });
    const names = async (reviewedSha: string | null | undefined) =>
      (await promptContext(bot("gate-bot", { skillIds: ["gated"] }), true, { skills: [skill(reviewedSha)], mcpServers: [] }, false)).skills.map((entry) => entry.name);
    expect(await names(sha256(text))).toEqual(["gated"]);
    expect(await names(undefined)).toEqual(["gated"]);
    expect(await names(null)).toEqual([]);
    expect(await names(sha256("something else"))).toEqual([]);
  });

  it("writes, reads and deletes library skills", async () => {
    const { writeSkill, readSkill, deleteSkill, sha256 } = await import("../server/library");
    const written = "---\nname: notes\ndescription: Keep notes\n---\n\nBody\n";
    expect(await writeSkill({ id: "notes", text: written })).toEqual({ description: "Keep notes", sha: sha256(written) });
    const read = await readSkill({ id: "notes" });
    expect(read.missing).toBe(false);
    expect(read.files).toEqual(["SKILL.md"]);
    await deleteSkill({ id: "notes" });
    expect((await readSkill({ id: "notes" })).missing).toBe(true);
  });

  it("links a bot's skills into its folder and drops links it no longer uses", async () => {
    const { writeSkill, linkBotSkills, librarySkillPath } = await import("../server/library");
    const { botDataPath } = await import("../server/bot-home");
    await writeSkill({ id: "a", text: "---\nname: a\ndescription: A\n---\n" });
    await writeSkill({ id: "b", text: "---\nname: b\ndescription: B\n---\n" });
    const paths = await linkBotSkills("bot-x", ["a", "b"]);
    expect(paths.get("a")).toBe(join(botDataPath("bot-x"), "skills", "a", "SKILL.md"));
    expect(await readlink(join(botDataPath("bot-x"), "skills", "a"))).toBe(librarySkillPath("a"));
    expect(await readFile(paths.get("b")!, "utf8")).toContain("description: B");
    await linkBotSkills("bot-x", ["b"]);
    await expect(readlink(join(botDataPath("bot-x"), "skills", "a"))).rejects.toThrow();
  });

  it("moves skills that lived in a bot's folder into the library", async () => {
    const { migrateBotSkills, readSkill } = await import("../server/library");
    const { botDataPath } = await import("../server/bot-home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(botDataPath("bot-old"), "skills", "legacy"), { recursive: true });
    await writeFile(join(botDataPath("bot-old"), "skills", "legacy", "SKILL.md"), "---\nname: legacy\ndescription: Old\n---\n");
    await migrateBotSkills();
    expect((await readSkill({ id: "legacy" })).text).toContain("Old");
  });

  it("exports a bot with its skills and redacted servers, and imports it back", async () => {
    const { writeSkill } = await import("../server/library");
    const { exportBot, importBot } = await import("../server/share");
    await writeSkill({ id: "shared", text: "---\nname: shared\ndescription: S\n---\n" });
    const library: Library = {
      skills: [{ id: "shared", description: "S", source: "", enabled: true, createdAt: NOW, updatedAt: NOW }],
      mcpServers: [
        { id: "m1", name: "gh", description: "", enabled: true, config: { type: "http", url: "https://x", headers: { Authorization: "Bearer secret" } }, tools: null, checkedAt: null, checkError: null, createdAt: NOW, updatedAt: NOW },
      ],
    };
    const { json } = await exportBot({ bot: bot("src", { skillIds: ["shared"], mcpServerIds: ["m1"] }), includeMemory: false }, library);
    expect(json).not.toContain("secret");
    const imported = await importBot({ botId: "bot-new", json });
    expect(imported.bot.skillIds).toEqual(["shared"]);
    expect(imported.skills.map((skill) => skill.id)).toEqual(["shared"]);
    expect(imported.mcpServers[0]).toMatchObject({ name: "gh", config: { headers: { Authorization: "<redacted>" } } });
  });

  it("still imports v1 files that kept skills and servers on the bot", async () => {
    const { importBot } = await import("../server/share");
    const v1 = {
      // Exported before the rename.
      format: "paseo-bot",
      version: 1,
      bot: { name: "Old", avatar: { seed: "s" }, provider: "claude", mcpServers: [fetchDraft], skills: [{ name: "Old Skill", description: "d", enabled: true }], routines: [] },
      files: { "skills/Old Skill/SKILL.md": "---\nname: old-skill\n---\n" },
    };
    const imported = await importBot({ botId: "bot-v1", json: JSON.stringify(v1) });
    expect(imported.bot.skillIds).toEqual(["old-skill"]);
    expect(imported.mcpServers.map((server) => server.name)).toEqual(["fetch"]);
  });
});

describe("probeMcpServer", () => {
  const fakeServer = `
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
      if (msg.method === "tools/list" && !msg.params.cursor) console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echoes\\nsecond line" }], nextCursor: "p2" } }));
      if (msg.method === "tools/list" && msg.params.cursor === "p2") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "add" }] } }));
    });`;

  it("lists a stdio server's tools across pages", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const result = await probeMcpServer({ config: { type: "stdio", command: process.execPath, args: ["-e", fakeServer], env: {} } });
    expect(result).toEqual({ ok: true, tools: [{ name: "echo", description: "Echoes" }, { name: "add", description: "" }] });
  });

  it("reports a command that can't start or exits, without leaking env values", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const missing = await probeMcpServer({ config: { type: "stdio", command: "definitely-not-a-command-xyz", args: [], env: {} } });
    expect(missing.ok).toBe(false);
    const exits = await probeMcpServer({ config: { type: "stdio", command: process.execPath, args: ["-e", "console.error('bad key ' + process.env.TOKEN); process.exit(3)"], env: { TOKEN: "sk-12345" } } });
    expect(exits).toMatchObject({ ok: false });
    expect(!exits.ok && exits.error).toContain("code 3");
    expect(!exits.ok && exits.error).not.toContain("sk-12345");
  });

  it("speaks streamable HTTP with a session and event-stream answers", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const seen: string[] = [];
    const http = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        if (request.method !== "POST") return response.writeHead(200).end();
        seen.push(`${request.headers["mcp-session-id"] ?? "-"} ${request.headers.authorization ?? "-"}`);
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.id === undefined) return response.writeHead(202).end();
        if (msg.method === "initialize") {
          response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s1" });
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: "Find" }] } })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as { port: number };
    try {
      const result = await probeMcpServer({ config: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer t" } } });
      expect(result).toEqual({ ok: true, tools: [{ name: "search", description: "Find" }] });
      expect(seen).toEqual(["- Bearer t", "s1 Bearer t", "s1 Bearer t"]);
    } finally {
      http.close();
    }
  });
});
