import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botLimits } from "../shared/bot";
import { shellCommand } from "../shared/commands";
import { makeBot } from "./helpers";

describe("allowed commands", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-commands-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("matches only the exact command in the exact folder", async () => {
    const { CommandAllowlist } = await import("../server/commands");
    const commands = new CommandAllowlist();
    const rule = await commands.add("bot-a", "npm test", "/work/app");
    expect(await commands.add("bot-a", "npm test", "/work/app")).toEqual(rule);
    expect(await commands.list("bot-a")).toEqual([rule]);
    expect(await commands.matches("bot-a", "npm test", "/work/app")).toBe(true);
    expect(await commands.matches("bot-a", "npm test && rm -rf /", "/work/app")).toBe(false);
    expect(await commands.matches("bot-a", "npm test", "/work/other")).toBe(false);
    expect(await commands.matches("bot-b", "npm test", "/work/app")).toBe(false);
    expect(await commands.remove("bot-a", rule.id)).toBe(true);
    expect(await commands.matches("bot-a", "npm test", "/work/app")).toBe(false);
    await expect(commands.add("bot-a", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'", "/w")).rejects.toThrow("credentials");
    await expect(commands.add("bot-a", "ls", "relative/dir")).rejects.toThrow("absolute path");
    await expect(commands.add("bot-a", "ls", "/work/../etc")).rejects.toThrow("absolute path");
  });

  it("reads the command and folder of a shell approval", () => {
    expect(shellCommand({ detail: { type: "shell", command: "git status" } }, "/chat")).toEqual({ command: "git status", cwd: "/chat" });
    expect(shellCommand({ detail: { type: "shell", command: "ls", cwd: "/elsewhere" } }, "/chat")).toEqual({ command: "ls", cwd: "/elsewhere" });
    expect(shellCommand({ detail: { type: "edit", filePath: "/a" } }, "/chat")).toBeNull();
    expect(shellCommand({}, "/chat")).toBeNull();
  });
});

describe("what a bot won't do", () => {
  it("follows its settings", () => {
    expect(botLimits(makeBot(), { local: true, appsConfigured: true })).toEqual([
      "Asks before running commands and tools it isn't allowed to use.",
      "Asks before contacting other bots.",
      "Has no connected apps.",
      "Won't act on a schedule.",
      "Keeps skills and routines only after you confirm them.",
    ]);
    const busy = makeBot({ modeId: "bypassPermissions", contactBots: "allow", apps: ["gmail"], routines: [{ id: "r", name: "r", prompt: "p", enabled: true, schedule: { kind: "webhook" }, resultsChatId: null, createdAt: "" }] });
    expect(botLimits(busy, { local: true, appsConfigured: true })).toEqual(["Keeps skills and routines only after you confirm them."]);
    expect(botLimits(busy, { local: false, appsConfigured: true })).toEqual(["Can't contact other bots.", "Has no connected apps."]);
  });
});
