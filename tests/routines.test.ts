import { describe, expect, it } from "vitest";
import { migrateV1, pushHistory, toolGrants, type Bot, type Routine } from "../shared/bot";
import { decide, describeSchedule, latestDue, nextRun } from "../shared/routines";

const at = (text: string) => new Date(text);

function routine(patch: Partial<Routine>): Routine {
  return { id: "rt", name: "r", prompt: "p", enabled: true, schedule: { kind: "interval", minutes: 60 }, createdAt: "2026-09-01T00:00:00", ...patch };
}

describe("latestDue", () => {
  it("daily picks today's slot once it has passed", () => {
    const schedule = { kind: "daily" as const, time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(latestDue(schedule, at("2026-09-25T09:00:00"), at("2026-09-26T08:59:00"))).toBeNull();
    expect(latestDue(schedule, at("2026-09-25T09:00:00"), at("2026-09-26T09:01:00"))).toEqual(at("2026-09-26T09:00:00"));
    expect(latestDue(schedule, at("2026-09-26T09:00:00"), at("2026-09-26T12:00:00"))).toBeNull();
  });

  it("daily skips excluded weekdays", () => {
    // 2026-09-26 is a Saturday.
    const weekdays = { kind: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] };
    expect(latestDue(weekdays, at("2026-09-24T09:00:00"), at("2026-09-26T10:00:00"))).toEqual(at("2026-09-25T09:00:00"));
  });

  it("interval and once", () => {
    expect(latestDue({ kind: "interval", minutes: 30 }, at("2026-09-26T10:00:00"), at("2026-09-26T10:29:00"))).toBeNull();
    expect(latestDue({ kind: "interval", minutes: 30 }, at("2026-09-26T10:00:00"), at("2026-09-26T10:31:00"))).toEqual(at("2026-09-26T10:30:00"));
    expect(latestDue({ kind: "once", at: "2026-09-26T10:00:00" }, at("2026-09-26T09:00:00"), at("2026-09-26T10:05:00"))).toEqual(at("2026-09-26T10:00:00"));
    expect(latestDue({ kind: "once", at: "2026-09-26T10:00:00" }, at("2026-09-26T10:00:00"), at("2026-09-26T11:00:00"))).toBeNull();
  });
});

describe("decide", () => {
  it("runs due routines, skips long-missed ones and ignores disabled ones", () => {
    const hourly = routine({});
    expect(decide(hourly, "2026-09-26T09:00:00", at("2026-09-26T10:01:00")).action).toBe("run");
    expect(decide(hourly, "2026-09-25T09:00:00", at("2026-09-26T10:01:00")).action).toBe("skip-missed");
    expect(decide(routine({ enabled: false }), null, at("2026-09-26T10:01:00")).action).toBe("wait");
  });
});

describe("nextRun and describeSchedule", () => {
  it("describes and projects schedules", () => {
    const weekdays = { kind: "daily" as const, time: "08:30", weekdays: [1, 2, 3, 4, 5] };
    expect(describeSchedule(weekdays)).toBe("Weekdays at 08:30");
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("Every 2h");
    expect(nextRun(weekdays, at("2026-09-25T08:30:00"), at("2026-09-26T10:00:00"))).toEqual(at("2026-09-28T08:30:00"));
  });
});

describe("migration, history and grants", () => {
  it("moves v1 fields into v2", () => {
    const migrated = migrateV1({ bots: [{ id: "b", name: "B", instructions: "be nice", avatarSeed: "s" }] }) as { bots: Record<string, unknown>[] };
    expect(migrated.bots[0]).toMatchObject({ soul: "be nice", avatar: { seed: "s" } });
    expect(migrated.bots[0]).not.toHaveProperty("instructions");
  });

  it("coalesces rapid edits into one undo step", () => {
    const bot = { id: "b" } as Bot;
    const one = pushHistory([], bot, at("2026-09-26T10:00:00Z"));
    expect(pushHistory(one, bot, at("2026-09-26T10:00:30Z"))).toHaveLength(1);
    expect(pushHistory(one, bot, at("2026-09-26T10:02:00Z"))).toHaveLength(2);
  });

  it("parses exact tool grants", () => {
    expect(toolGrants(["gmail/search_threads", "bad", " fetch/fetch "])).toEqual([
      { kind: "mcp", server: "gmail", tool: "search_threads" },
      { kind: "mcp", server: "fetch", tool: "fetch" },
    ]);
  });
});

import { parseSkillFrontmatter, parseSkillSource, sanitizeSkillName } from "../shared/skills";

describe("skill sources", () => {
  it("parses shorthand, GitHub URLs and raw links", () => {
    expect(parseSkillSource("anthropics/skills")).toEqual({ kind: "github", owner: "anthropics", repo: "skills", ref: null, path: "" });
    expect(parseSkillSource("anthropics/skills/document-skills/pdf")).toMatchObject({ path: "document-skills/pdf" });
    expect(parseSkillSource("https://github.com/o/r/blob/main/skills/x/SKILL.md")).toEqual({ kind: "github", owner: "o", repo: "r", ref: "main", path: "skills/x" });
    expect(parseSkillSource("https://github.com/o/r/tree/dev/skills")).toMatchObject({ ref: "dev", path: "skills" });
    expect(parseSkillSource("https://example.com/a/SKILL.md")).toEqual({ kind: "raw", url: "https://example.com/a/SKILL.md" });
    expect(() => parseSkillSource("nonsense")).toThrow();
  });

  it("reads frontmatter and sanitizes names", () => {
    expect(parseSkillFrontmatter('---\nname: "PDF Tools"\ndescription: Work with PDFs\n---\n# body')).toEqual({ name: "PDF Tools", description: "Work with PDFs" });
    expect(parseSkillFrontmatter("# no frontmatter")).toEqual({ name: null, description: null });
    expect(sanitizeSkillName("PDF Tools!")).toBe("pdf-tools");
  });
});

import { CRON_PRESETS, describeCron, scheduleToCron, validateCron } from "../shared/routines";

describe("cron routines", () => {
  it("validates with Paseo's messages", () => {
    expect(validateCron("")).toBe("Enter a cron expression");
    expect(validateCron("0 9 * *")).toBe("Cron expressions must have 5 fields");
    expect(validateCron("0 24 * * *")).toBe("Invalid hour value");
    expect(validateCron("0 9 * * 1-7")).toBe("Invalid day-of-week range");
    expect(validateCron("*/0 * * * *")).toBe("Invalid minute step");
    for (const preset of CRON_PRESETS) expect(validateCron(preset.expression)).toBeNull();
  });

  it("describes common shapes and falls back to null", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeCron("30 8 * * 1-5")).toBe("Weekdays at 08:30");
    expect(describeCron("0 9 * * 1")).toBe("Mondays at 09:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 9 1 * *")).toBeNull();
    expect(describeCron("nope")).toBeNull();
    expect(describeSchedule({ kind: "cron", expression: "0 9 1 * *" })).toBe("0 9 1 * *");
  });

  it("finds the next and latest due minutes in local time", () => {
    const weekdays = { kind: "cron" as const, expression: "0 9 * * 1-5" };
    // 2026-09-26 is a Saturday.
    expect(nextRun(weekdays, at("2026-09-25T09:00:00"), at("2026-09-26T10:00:00"))).toEqual(at("2026-09-28T09:00:00"));
    expect(latestDue(weekdays, at("2026-09-24T09:00:00"), at("2026-09-26T10:00:00"))).toEqual(at("2026-09-25T09:00:00"));
    expect(latestDue(weekdays, at("2026-09-25T09:00:30"), at("2026-09-26T10:00:00"))).toBeNull();
    const quarter = { kind: "cron" as const, expression: "*/15 * * * *" };
    expect(latestDue(quarter, at("2026-09-26T10:00:00"), at("2026-09-26T10:31:00"))).toEqual(at("2026-09-26T10:30:00"));
    expect(nextRun(quarter, at("2026-09-26T10:30:00"), at("2026-09-26T10:31:00"))).toEqual(at("2026-09-26T10:45:00"));
    expect(nextRun({ kind: "cron", expression: "bad" }, at("2026-09-26T10:00:00"), at("2026-09-26T10:00:00"))).toBeNull();
  });

  it("runs cron routines through decide", () => {
    const daily = routine({ schedule: { kind: "cron", expression: "0 9 * * *" } });
    expect(decide(daily, "2026-09-25T09:00:10", at("2026-09-26T09:00:30")).action).toBe("run");
    expect(decide(daily, "2026-09-26T09:00:30", at("2026-09-26T09:01:00")).action).toBe("wait");
    expect(decide(daily, "2026-09-24T09:00:10", at("2026-09-26T22:00:00")).action).toBe("skip-missed");
  });

  it("reads older schedules as cron for the editor", () => {
    expect(scheduleToCron({ kind: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] })).toBe("30 8 * * 1-5");
    expect(scheduleToCron({ kind: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("0 9 * * *");
    expect(scheduleToCron({ kind: "interval", minutes: 30 })).toBe("*/30 * * * *");
    expect(scheduleToCron({ kind: "interval", minutes: 60 })).toBe("0 * * * *");
    expect(scheduleToCron({ kind: "interval", minutes: 240 })).toBe("0 */4 * * *");
    expect(scheduleToCron({ kind: "once", at: "2026-09-26T10:00:00" })).toBeNull();
  });
});
