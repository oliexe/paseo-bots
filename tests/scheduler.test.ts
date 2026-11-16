import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Routine } from "../shared/bot";
import { upcomingRuns } from "../shared/routines";
import { fakeHost, makeBot } from "./helpers";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

function routine(patch: Partial<Routine> = {}): Routine {
  return { id: "rt-1", name: "Inbox check", prompt: "Check the inbox.", enabled: true, schedule: { kind: "cron", expression: "0 9 * * 1-5" }, resultsChatId: null, createdAt: local(1, 0).toISOString(), ...patch };
}

describe("routine schedules from chat", () => {
  it("reads each schedule type and explains what's wrong", async () => {
    const { scheduleFrom } = await import("../shared/routines");
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
    const temporary = process.env.HS_TEMP || join(homedir(), "Temp");
    await mkdir(temporary, { recursive: true });
    home = await mkdtemp(join(temporary, "paseo-bots-scheduler-"));
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
    const scheduler = new RoutineScheduler(host, relay, { autoStart: false });
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
      await scheduler.stop();
      relay.stop();
    }
  });

  async function fixture(id: string, agent: Record<string, unknown> = { status: "idle", archivedAt: null }) {
    const { Relay } = await import("../server/relay");
    const { RoutineScheduler } = await import("../server/scheduler");
    const host = fakeHost([makeBot({ id: "bot-r", routines: [routine({ id, createdAt: new Date().toISOString() })] })]);
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } as never);
    const relay = new Relay(host, []);
    const scheduler = new RoutineScheduler(host, relay, { autoStart: false });
    const launch = scheduler as unknown as { newChat: (_bot: unknown, _routine: unknown, prompt: string, agentId: string) => Promise<string> };
    launch.newChat = async (_bot, _routine, _prompt, agentId) => agentId;
    return { host, scheduler, relay, launch, close: async () => { await scheduler.stop(); relay.stop(); } };
  }

  it("records a turn that finishes before agent creation returns", async () => {
    const f = await fixture("rt-fast");
    f.launch.newChat = async (_bot, _routine, _prompt, agentId) => {
      await f.scheduler.finished("rt-fast", agentId, { kind: "completed" }, "Already finished.");
      return agentId;
    };
    try {
      expect((await f.scheduler.runNow("bot-r", "rt-fast")).run).toMatchObject({ status: "succeeded", output: "Already finished." });
      expect((await f.scheduler.status()).routines["rt-fast"]?.runs).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("prevents concurrent manual starts while the first agent is still being created", async () => {
    const f = await fixture("rt-concurrent");
    let release!: () => void;
    let began!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { began = resolve; });
    let creates = 0;
    f.launch.newChat = async (_bot, _routine, _prompt, agentId) => { creates++; began(); await held; return agentId; };
    try {
      const first = f.scheduler.runNow("bot-r", "rt-concurrent");
      await entered;
      const second = await f.scheduler.runNow("bot-r", "rt-concurrent");
      expect(second.run.status).toBe("skipped-busy");
      release();
      expect((await first).run.status).toBe("running");
      expect(creates).toBe(1);
      expect((await f.scheduler.status()).routines["rt-concurrent"]?.lastRunAt).toBeNull();
    } finally { release(); await f.close(); }
  });

  it("does not overlap a run waiting for permission even when its agent reports idle", async () => {
    const f = await fixture("rt-permission", { status: "idle", archivedAt: null, pendingPermissions: [{ id: "approve" }] });
    try {
      await f.scheduler.runNow("bot-r", "rt-permission");
      expect((await f.scheduler.runNow("bot-r", "rt-permission")).run.status).toBe("skipped-busy");
    } finally { await f.close(); }
  });

  it("serializes webhook secrets, rotates them and retains every routine's URL", async () => {
    const f = await fixture("rt-secrets");
    try {
      const urls = await Promise.all(Array.from({ length: 12 }, () => f.scheduler.webhookUrl("rt-secrets")));
      expect(new Set(urls.map(({ url }) => url)).size).toBe(1);
      const others = await Promise.all([f.scheduler.webhookUrl("rt-secrets-a"), f.scheduler.webhookUrl("rt-secrets-b")]);
      expect(await f.scheduler.webhookUrl("rt-secrets-a")).toEqual(others[0]);
      expect(await f.scheduler.webhookUrl("rt-secrets-b")).toEqual(others[1]);
      expect((await f.scheduler.webhookUrl("rt-secrets", true)).url).not.toBe(urls[0]!.url);
      await expect(f.scheduler.webhookUrl("../escape")).rejects.toThrow("Invalid routine ID");
    } finally { await f.close(); }
  });

  it("surfaces creation errors and can run again after failure", async () => {
    const f = await fixture("rt-error");
    f.launch.newChat = async () => { throw new Error("Provider is unavailable"); };
    try {
      expect((await f.scheduler.runNow("bot-r", "rt-error")).run).toMatchObject({ status: "failed", error: "Provider is unavailable" });
      f.launch.newChat = async (_bot, _routine, _prompt, agentId) => agentId;
      expect((await f.scheduler.runNow("bot-r", "rt-error")).run.status).toBe("running");
    } finally { await f.close(); }
  });

  it("deduplicates manual requests across concurrent calls, completion, restart and trimmed history", async () => {
    const f = await fixture("rt-receipt");
    const launch = vi.fn(async (_bot: unknown, _routine: unknown, _prompt: string, agentId: string) => agentId);
    f.launch.newChat = launch;
    try {
      const runs = await Promise.all(Array.from({ length: 5 }, () => f.scheduler.runNow("bot-r", "rt-receipt", "same-request")));
      expect(new Set(runs.map(({ run }) => run.id)).size).toBe(1);
      expect(launch).toHaveBeenCalledTimes(1);
      const first = runs[0]!.run;
      await f.scheduler.finished("rt-receipt", first.agentId!, { kind: "completed" }, "Done once");
      expect((await f.scheduler.runNow("bot-r", "rt-receipt", "same-request")).run).toMatchObject({ id: first.id, status: "succeeded" });
      await f.scheduler.stop();
      const { RoutineScheduler } = await import("../server/scheduler");
      const restarted = new RoutineScheduler(f.host, f.relay, { autoStart: false });
      try {
        expect((await restarted.runNow("bot-r", "rt-receipt", "same-request")).run.id).toBe(first.id);
        const path = join(home, "plugin-data", "paseo-bots", "routines.json");
        const records = JSON.parse(await readFile(path, "utf8"));
        records["rt-receipt"].runs = [];
        await writeFile(path, JSON.stringify(records));
        await expect(restarted.runNow("bot-r", "rt-receipt", "same-request")).rejects.toThrow("already started run");
        expect((await restarted.status()).routines["rt-receipt"]!.runs).toEqual([]);
      } finally { await restarted.stop(); }
    } finally { await f.close(); }
  });

  async function cancelFixture(id: string, permission = false) {
    const agent = { status: permission ? "idle" : "running", archivedAt: null as string | null, labels: { "paseo-bots.bot": "bot-r", "paseo-bots.routine": id }, pendingPermissions: permission ? [{ id: "permission-1" }] : [] };
    const f = await fixture(id, agent);
    const reload = vi.fn(async () => { agent.status = "idle"; return { agent }; });
    const respondToPermission = vi.fn(async (_input: unknown) => { agent.pendingPermissions = []; agent.status = "idle"; });
    f.host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent }), reload, respondToPermission }) } } as never);
    return { ...f, agent, reload, respondToPermission };
  }

  it("stops a running routine once through public reload and preserves the stopped outcome", async () => {
    const f = await cancelFixture("rt-cancel");
    try {
      const { run } = await f.scheduler.runNow("bot-r", "rt-cancel");
      const results = await Promise.all(Array.from({ length: 4 }, () => f.scheduler.cancelRun("bot-r", "rt-cancel", run.id)));
      expect(results.every((result) => result.run.status === "canceled" && result.sessionReopened)).toBe(true);
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(f.respondToPermission).not.toHaveBeenCalled();
      expect((await f.scheduler.cancelRun("bot-r", "rt-cancel", run.id)).run.status).toBe("canceled");
      await f.scheduler.finished("rt-cancel", run.agentId!, { kind: "completed" }, "A later turn");
      expect((await f.scheduler.status()).routines["rt-cancel"]!.runs[0]!.status).toBe("canceled");
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect((await f.host.bot("bot-r"))!.routines[0]!.enabled).toBe(true);
    } finally { await f.close(); }
  });

  it("interrupts a permission-waiting run without reopening its provider session", async () => {
    const f = await cancelFixture("rt-cancel-permission", true);
    try {
      const { run } = await f.scheduler.runNow("bot-r", "rt-cancel-permission");
      const result = await f.scheduler.cancelRun("bot-r", "rt-cancel-permission", run.id);
      expect(result).toMatchObject({ run: { status: "canceled" }, sessionReopened: false });
      expect(f.respondToPermission).toHaveBeenCalledWith(expect.objectContaining({ requestId: "permission-1", response: expect.objectContaining({ behavior: "deny", interrupt: true }) }));
      expect(f.reload).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("waits for reserved agent creation before completing cancellation", async () => {
    const f = await cancelFixture("rt-cancel-launch");
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.launch.newChat = async (_bot, _routine, _prompt, agentId) => { entered(); await held; return agentId; };
    try {
      const launching = f.scheduler.runNow("bot-r", "rt-cancel-launch");
      await started;
      const reserved = (await f.scheduler.status()).routines["rt-cancel-launch"]!.runs[0]!;
      const canceling = f.scheduler.cancelRun("bot-r", "rt-cancel-launch", reserved.id);
      expect(f.reload).not.toHaveBeenCalled();
      release();
      await launching;
      expect((await canceling).run.status).toBe("canceled");
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect((await f.scheduler.status()).routines["rt-cancel-launch"]!.runs[0]!.status).toBe("canceled");
    } finally { release(); await f.close(); }
  });

  it("refuses wrong ownership and missing runs, and retries a failed stop without reporting success", async () => {
    const f = await cancelFixture("rt-cancel-errors");
    try {
      const { run } = await f.scheduler.runNow("bot-r", "rt-cancel-errors");
      await expect(f.scheduler.cancelRun("another-bot", "rt-cancel-errors", run.id)).rejects.toThrow("Routine not found");
      await expect(f.scheduler.cancelRun("bot-r", "rt-cancel-errors", "unknown")).rejects.toThrow("retained history");
      f.agent.labels["paseo-bots.bot"] = "another-bot";
      await expect(f.scheduler.cancelRun("bot-r", "rt-cancel-errors", run.id)).rejects.toThrow("original chat");
      expect(f.reload).not.toHaveBeenCalled();
      f.agent.labels["paseo-bots.bot"] = "bot-r";
      f.reload.mockRejectedValueOnce(new Error("Host disconnected"));
      await expect(f.scheduler.cancelRun("bot-r", "rt-cancel-errors", run.id)).rejects.toThrow("Host disconnected");
      expect((await f.scheduler.status()).routines["rt-cancel-errors"]!.runs[0]!.status).toBe("running");
      expect((await f.scheduler.cancelRun("bot-r", "rt-cancel-errors", run.id)).run.status).toBe("canceled");
      expect(f.reload).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("does not overwrite a successful completion racing cancellation", async () => {
    const f = await cancelFixture("rt-cancel-finish");
    try {
      const { run } = await f.scheduler.runNow("bot-r", "rt-cancel-finish");
      f.reload.mockImplementationOnce(async () => {
        await f.scheduler.finished("rt-cancel-finish", run.agentId!, { kind: "completed" }, "Finished before interruption");
        return { agent: f.agent };
      });
      expect((await f.scheduler.cancelRun("bot-r", "rt-cancel-finish", run.id)).run).toMatchObject({ status: "succeeded", output: "Finished before interruption" });
    } finally { await f.close(); }
  });

  it("does not let a delayed running card overwrite its final result", async () => {
    const f = await fixture("rt-card-race");
    (await f.host.bot("bot-r"))!.routines[0]!.resultsChatId = "results-chat";
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const published: string[] = [];
    f.host.attach({ agents: { ref: () => ({
      refresh: async () => ({ agent: { status: "running" } }),
      timeline: { append: async (item: { data: { status: string } }) => {
        if (item.data.status === "running") { entered(); await held; }
        published.push(item.data.status);
      } },
    }) } } as never);
    try {
      const launching = f.scheduler.runNow("bot-r", "rt-card-race");
      await started;
      const run = (await f.scheduler.status()).routines["rt-card-race"]!.runs[0]!;
      const finishing = f.scheduler.finished("rt-card-race", run.agentId!, { kind: "completed" }, "Final answer");
      await vi.waitFor(async () => expect((await f.scheduler.status()).routines["rt-card-race"]!.runs[0]!.status).toBe("succeeded"));
      release();
      await Promise.all([launching, finishing]);
      expect(published).toEqual(["running", "succeeded"]);
    } finally { release(); await f.close(); }
  });

  it("retains active runs when recording missed scheduled occurrences", async () => {
    const f = await fixture("rt-retain-missed");
    const path = join(home, "plugin-data", "paseo-bots", "routines.json");
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const own = (await f.host.bot("bot-r"))!.routines[0]!;
    own.schedule = { kind: "interval", minutes: 5 };
    own.createdAt = old;
    const records = JSON.parse(await readFile(path, "utf8"));
    records[own.id] = { lastRunAt: old, runs: Array.from({ length: 30 }, (_, index) => ({ id: `retained-${index}`, trigger: "manual", scheduledFor: old, startedAt: old, endedAt: index === 0 ? null : old, status: index === 0 ? "running" : "failed", agentId: index === 0 ? "still-active" : null, output: null, error: null })) };
    await writeFile(path, JSON.stringify(records));
    try {
      await (f.scheduler as unknown as { tick(): Promise<void> }).tick();
      const runs = (await f.scheduler.status()).routines[own.id]!.runs;
      expect(runs[0]).toMatchObject({ id: "retained-0", status: "running" });
      expect(runs.at(-1)?.status).toBe("skipped-missed");
      expect(runs).toHaveLength(31);
    } finally { await f.close(); }
  });

  it("releases a launch reservation if its durable write fails", async () => {
    const f = await fixture("rt-write-failure");
    const launch = vi.fn(async (_bot: unknown, _routine: unknown, _prompt: string, agentId: string) => agentId);
    f.launch.newChat = launch;
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Disk unavailable"));
    try {
      await expect(f.scheduler.runNow("bot-r", "rt-write-failure")).rejects.toThrow("Disk unavailable");
      expect(launch).not.toHaveBeenCalled();
      expect((f.scheduler as unknown as { launching: Set<string> }).launching.size).toBe(0);
      expect((await f.scheduler.runNow("bot-r", "rt-write-failure")).run.status).toBe("running");
      expect(launch).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("does not resurrect its timer or dispatch work after disposal", async () => {
    const f = await fixture("rt-disposed");
    await f.scheduler.stop();
    f.host.attach({ agents: {} } as never);
    expect(f.scheduler.running).toBe(false);
    await expect(f.scheduler.runNow("bot-r", "rt-disposed")).rejects.toThrow("stopped");
    await expect(f.scheduler.webhookUrl("rt-disposed")).rejects.toThrow("stopped");
    await f.close();
  });

  it("fails closed on corrupted state without overwriting the saved history", async () => {
    const f = await fixture("rt-corruption");
    const path = join(home, "plugin-data", "paseo-bots", "routines.json");
    const before = await readFile(path, "utf8");
    try {
      await writeFile(path, '{"unfinished":');
      await expect(f.scheduler.runNow("bot-r", "rt-corruption")).rejects.toThrow("Could not read");
      expect(await readFile(path, "utf8")).toBe('{"unfinished":');
    } finally { await writeFile(path, before); await f.close(); }
  });
});
