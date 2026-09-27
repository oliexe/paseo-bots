import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Routine } from "../shared/bot";
import { upcomingRuns } from "../shared/routines";
import { fakeHost, makeBot } from "./helpers";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

function routine(patch: Partial<Routine> = {}): Routine {
  return { id: "rt-1", name: "Inbox check", prompt: "Check the inbox.", enabled: true, schedule: { kind: "cron", expression: "0 9 * * 1-5" }, resultsChatId: null, createdAt: local(1, 0).toISOString(), ...patch };
}

describe("routine schedules from chat", () => {
  it("reads each schedule type and explains what's wrong", async () => {
    const { scheduleFrom } = await import("../server/tools/routines");
    const now = local(27, 12);
    expect(scheduleFrom({ type: "daily", time: "08:30", weekdays: [5, 1, 1] }, now)).toEqual({ kind: "daily", time: "08:30", weekdays: [1, 5] });
    expect(scheduleFrom({ type: "cron", expression: " 0 9 * * 1-5 " }, now)).toEqual({ kind: "cron", expression: "0 9 * * 1-5" });
    expect(scheduleFrom({ type: "once", at: "2026-09-28 09:00" }, now)).toEqual({ kind: "once", at: local(28, 9).toISOString() });
    expect(scheduleFrom({ type: "interval", every_minutes: 30 }, now)).toEqual({ kind: "interval", minutes: 30 });
    expect(scheduleFrom({ type: "webhook" }, now)).toEqual({ kind: "webhook" });
    expect(() => scheduleFrom({ type: "once", at: "2026-09-01 09:00" }, now)).toThrow("already passed");
    expect(() => scheduleFrom({ type: "daily", time: "25:00" }, now)).toThrow('"HH:MM"');
    expect(() => scheduleFrom({ type: "cron", expression: "0 9 * *" }, now)).toThrow("5 fields");
    expect(() => scheduleFrom({ type: "interval" }, now)).toThrow("every_minutes");
  });

  it("lists the next runs", () => {
    // 2026-09-25 is a Friday.
    const now = local(25, 12);
    expect(upcomingRuns({ kind: "cron", expression: "0 9 * * 1-5" }, now, now, 3)).toEqual([local(28, 9), local(29, 9), local(30, 9)]);
    expect(upcomingRuns({ kind: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, now, now, 2)).toEqual([local(25, 18), local(26, 18)]);
    expect(upcomingRuns({ kind: "interval", minutes: 60 }, local(25, 11, 30), now, 2)).toEqual([local(25, 12, 30), local(25, 13, 30)]);
    expect(upcomingRuns({ kind: "once", at: local(26, 9).toISOString() }, now, now, 3)).toEqual([local(26, 9)]);
    expect(upcomingRuns({ kind: "webhook" }, now, now, 3)).toEqual([]);
  });

  it("hands a webhook's body to the bot as marked data", async () => {
    const { runPrompt } = await import("../server/scheduler");
    const prompt = runPrompt(routine(), { body: '{"order": 42}', contentType: "application/json", receivedAt: "2026-09-27T10:00:00.000Z" });
    expect(prompt).toContain("Check the inbox.\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nReceived: 2026-09-27T10:00:00.000Z\nContent type: application/json\n\n{\"order\": 42}\n[END WEBHOOK EVENT DATA]");
    expect(runPrompt(routine())).toBe("Check the inbox.");
  });
});

describe("the routine scheduler", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-scheduler-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("records runs, posts cards to the results chat, and finishes them when the chat's turn ends", async () => {
    const { Relay } = await import("../server/relay");
    const { RoutineScheduler } = await import("../server/scheduler");
    const hook = routine({ id: "rt-hook", name: "Orders", schedule: { kind: "webhook" }, resultsChatId: "results-chat" });
    // Created now, so the first tick has no missed run to record.
    const host = fakeHost([makeBot({ id: "bot-r", routines: [routine({ createdAt: new Date().toISOString() }), hook] })]);
    const appended: { agentId: string; item: { id: string; kind: string; data: { status: string; output: string | null } } }[] = [];
    const status = new Map<string, string>();
    host.attach({
      agents: {
        ref: (agentId: string) => ({
          refresh: async () => ({ agent: { status: status.get(agentId) ?? "idle", archivedAt: null } }),
          timeline: { append: async (item: never) => void appended.push({ agentId, item }) },
        }),
      },
    } as never);
    const relay = new Relay(host, []);
    const scheduler = new RoutineScheduler(host, relay);
    scheduler.stop();
    let started = 0;
    const prompts: string[] = [];
    (scheduler as unknown as { newChat: (...args: unknown[]) => Promise<string> }).newChat = async (_bot, _routine, prompt) => {
      prompts.push(prompt as string);
      return `run-chat-${++started}`;
    };
    try {
      const manual = await scheduler.runNow("bot-r", "rt-1");
      expect(manual.run).toMatchObject({ trigger: "manual", status: "running", agentId: "run-chat-1" });
      // No results chat: nothing is posted.
      expect(appended).toHaveLength(0);

      // While that run's chat is working, the next run is skipped.
      status.set("run-chat-1", "running");
      expect((await scheduler.runNow("bot-r", "rt-1")).run.status).toBe("skipped-busy");

      const { url } = await scheduler.webhookUrl("rt-hook");
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/rt-hook\/[a-f0-9]{48}$/);
      expect((await fetch(url)).status).toBe(405);
      expect((await fetch(url.replace(/.{8}$/, "00000000"), { method: "POST" })).status).toBe(404);
      const call = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "order 42 shipped" });
      expect(call.status).toBe(202);
      expect(await call.json()).toEqual({ status: "running", chat: "run-chat-2" });
      expect(prompts[1]).toContain("order 42 shipped");
      expect(appended.at(-1)).toMatchObject({ agentId: "results-chat", item: { kind: "routine-run", data: { status: "running", output: null } } });

      // The run's turn ends: it's recorded and its card updated in place (same id).
      await scheduler.finished("rt-hook", "run-chat-2", { kind: "completed" }, "Shipped order 42 to Acme.");
      const last = appended.at(-1)!;
      expect(last.item.id).toBe(appended.at(-2)!.item.id);
      expect(last.item.data).toMatchObject({ status: "succeeded", output: "Shipped order 42 to Acme." });
      const { routines } = await scheduler.status();
      expect(routines["rt-hook"]!.runs.map((run) => [run.trigger, run.status])).toEqual([["webhook", "succeeded"]]);
      expect(routines["rt-1"]!.runs.map((run) => run.status)).toEqual(["running", "skipped-busy"]);

      // A rotated URL retires the old one.
      const { url: fresh } = await scheduler.webhookUrl("rt-hook", true);
      expect(fresh).not.toBe(url);
      expect((await fetch(url, { method: "POST" })).status).toBe(404);
    } finally {
      relay.stop();
    }
  });
});
