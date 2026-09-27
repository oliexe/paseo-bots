import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDefaults, DEFAULT_BOT_DEFAULTS, EMPTY_LIBRARY, numberedName, presetFromBot } from "../shared/bot";
import { addImportedBots } from "../shared/library";
import { makeBot } from "./helpers";

describe("defaults and presets", () => {
  it("starts new bots with the default agent", () => {
    const bot = makeBot({ provider: "", model: "m", modeId: "x" });
    expect(applyDefaults(bot, DEFAULT_BOT_DEFAULTS, "claude")).toMatchObject({ provider: "claude", model: null, modeId: null, contactBots: "ask" });
    const defaults = { ...DEFAULT_BOT_DEFAULTS, provider: "codex", model: "gpt-5", modeId: "auto", contactBots: "off" as const };
    expect(applyDefaults(bot, defaults, "claude")).toMatchObject({ provider: "codex", model: "gpt-5", modeId: "auto", contactBots: "off" });
  });

  it("keeps who a bot is and how it works, not its access", () => {
    const bot = makeBot({ name: "Inbox", soul: "Be brief.", skillIds: ["triage"], mcpServerIds: ["mcp-1"], apps: ["gmail"], playbooks: [{ id: "p", name: "Close", triggers: ["close"], instructions: "steps" }] });
    const preset = presetFromBot(bot, "2026-09-27T00:00:00.000Z");
    expect(preset).toMatchObject({ name: "Inbox", soul: "Be brief.", skillIds: ["triage"], playbooks: [{ name: "Close" }] });
    expect(preset).not.toHaveProperty("mcpServerIds");
    expect(preset).not.toHaveProperty("apps");
  });

  it("numbers imported bots whose names are taken", () => {
    expect(numberedName("Inbox", new Set(["Inbox", "Inbox 2"]))).toBe("Inbox 3");
    const values = { bots: [makeBot({ id: "a", name: "Inbox" })], history: [], library: EMPTY_LIBRARY };
    const next = addImportedBots(values, [
      { bot: makeBot({ id: "b", name: "Inbox" }), skills: [{ id: "triage", description: "d", source: "" }], mcpServers: [{ name: "fetch", enabled: true, config: { type: "http", url: "https://f", headers: {} } }] },
      { bot: makeBot({ id: "c", name: "Inbox" }), skills: [], mcpServers: [] },
    ]);
    expect(next.bots.map((bot) => bot.name)).toEqual(["Inbox", "Inbox 2", "Inbox 3"]);
    expect(next.library!.skills).toMatchObject([{ id: "triage", enabled: false, reviewedSha: null }]);
    expect(next.bots[1]!.mcpServerIds).toEqual([next.library!.mcpServers[0]!.id]);
  });
});

describe("team files", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-team-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("round-trips several bots, paused and without access", async () => {
    const { exportTeam, importTeam, isTeamFile } = await import("../server/share");
    const routine = { id: "rt", name: "Daily", prompt: "p", enabled: true, schedule: { kind: "cron" as const, expression: "0 9 * * *" }, resultsChatId: "chat-1", createdAt: "" };
    const bots = [makeBot({ id: "bot-a", name: "Inbox", apps: ["gmail"], contactBots: "allow", routines: [routine] }), makeBot({ id: "bot-b", name: "Scout" })];
    const { json } = await exportTeam({ bots, includeMemory: false }, EMPTY_LIBRARY);
    expect(isTeamFile(json)).toBe(true);
    const imported = await importTeam({ json });
    expect(imported.bots.map((entry) => entry.bot.name)).toEqual(["Inbox", "Scout"]);
    expect(imported.bots[0]!.bot).toMatchObject({ apps: [], contactBots: "ask", routines: [{ name: "Daily", enabled: false, resultsChatId: null }] });
    expect(new Set(imported.bots.map((entry) => entry.bot.id)).size).toBe(2);
    await expect(importTeam({ json: '{"format":"paseo-bots-team","version":1,"bots":[]}' })).rejects.toThrow("damaged");
  });
});
