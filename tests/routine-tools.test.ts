import { describe, expect, it, vi } from "vitest";
import { cancelRoutineRun, listRoutines, runRoutine } from "../server/tools/routines";
import type { RoutineService } from "../server/routine-service";
import type { Routine } from "../shared/bot";
import { QUIET_TOOLS } from "../shared/bot-tools";
import type { RoutineRun } from "../shared/rpc";
import { fakeHost, makeBot, NOW } from "./helpers";

const routine = (id: string, name = id): Routine => ({ id, name, prompt: "Check the inbox", enabled: true, schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5], timeZone: "Europe/Prague" }, createdAt: NOW, resultsChatId: "results" });
const run = (id: string): RoutineRun => ({ id, trigger: "manual", scheduledFor: NOW, startedAt: NOW, endedAt: null, status: "running", agentId: "run-chat", output: null, error: null });

function fixture() {
  const bot = makeBot({ routines: [routine("own", "Inbox"), routine("paused", "Paused")] });
  bot.routines[1]!.enabled = false;
  const host = fakeHost([bot, makeBot({ id: "other-bot", routines: [routine("other", "Private")] })]);
  const service: RoutineService = {
    status: vi.fn(async () => ({ scheduler: true, timeZone: "UTC", error: null, routines: {
      own: { lastRunAt: null, runs: [run("old"), run("new")], manualRequests: { sensitiveInternalReceipt: "old" } },
      other: { lastRunAt: null, runs: [{ ...run("other-run"), output: "Other bot's private data" }] },
    } })),
    runNow: vi.fn(async () => ({ run: run("requested") })),
    cancelRun: vi.fn(async () => ({ run: { ...run("requested"), status: "canceled" as const }, sessionReopened: true })),
  };
  const detach = host.attachRoutines(service);
  return { bot, host, service, detach, caller: { bot, host, agentId: "caller-chat", relay: null as never } };
}

describe("routine tools", () => {
  it("lists only the calling bot's schedules, explicit zones and bounded recent history", async () => {
    const f = fixture();
    const result = JSON.parse(await listRoutines.run(listRoutines.input.parse({ history_limit: 1 }), f.caller));
    expect(result.routines.map((entry: { id: string }) => entry.id)).toEqual(["own", "paused"]);
    expect(result.routines[0]).toMatchObject({ timeZone: "Europe/Prague", runs: [{ id: "new" }] });
    expect(result.routines[0].nextRunAt).toBeTruthy();
    expect(result.routines[1]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(JSON.stringify(result)).not.toContain("Other bot's private data");
    expect(JSON.stringify(result)).not.toContain("sensitiveInternalReceipt");
    expect(JSON.parse(await listRoutines.run(listRoutines.input.parse({ routine: " inbox ", history_limit: 0 }), f.caller)).routines[0].runs).toEqual([]);
  });

  it("rejects other bots' ids, duplicate names, stale bot snapshots and unsupported inputs", async () => {
    const f = fixture();
    for (const tool of [listRoutines, runRoutine, cancelRoutineRun]) {
      await expect(tool.run({ routine: "other", key: "k", run_id: "r", history_limit: 1 }, f.caller)).rejects.toThrow("belonging to this bot");
    }
    f.bot.routines.push(routine("duplicate", "Inbox"));
    await expect(runRoutine.run({ routine: "Inbox", key: "k" }, f.caller)).rejects.toThrow("Several");
    expect(runRoutine.input.safeParse({ routine: "own", key: " " }).success).toBe(false);
    expect(listRoutines.input.safeParse({ bot: "other-bot" }).success).toBe(false);
    expect(listRoutines.input.safeParse({ history_limit: 31 }).success).toBe(false);
    f.bot.archived = true;
    await expect(listRoutines.run({ history_limit: 1 }, f.caller)).rejects.toThrow("no longer available");
    expect(f.service.runNow).not.toHaveBeenCalled();
  });

  it("scopes retry keys by original chat and delegates execution without changing schedules", async () => {
    const f = fixture();
    await runRoutine.run({ routine: "own", key: "request-1" }, f.caller);
    await runRoutine.run({ routine: "own", key: "request-1" }, f.caller);
    await runRoutine.run({ routine: "own", key: "request-1" }, { ...f.caller, agentId: "another-chat" });
    expect(f.service.runNow).toHaveBeenNthCalledWith(1, "bot-1", "own", "caller-chat\0request-1");
    expect(f.service.runNow).toHaveBeenNthCalledWith(2, "bot-1", "own", "caller-chat\0request-1");
    expect(f.service.runNow).toHaveBeenNthCalledWith(3, "bot-1", "own", "another-chat\0request-1");
    expect(f.bot.routines[0]!.enabled).toBe(true);
    expect(QUIET_TOOLS).toContain("list_routines");
    expect(QUIET_TOOLS).not.toContain("run_routine");
    expect(QUIET_TOOLS).not.toContain("cancel_routine_run");
  });

  it("cancels the exact owned run and describes the provider session restart", async () => {
    const f = fixture();
    const result = JSON.parse(await cancelRoutineRun.run({ routine: "own", run_id: "requested" }, f.caller));
    expect(f.service.cancelRun).toHaveBeenCalledWith("bot-1", "own", "requested");
    expect(result.run.status).toBe("canceled");
    expect(result.instruction).toContain("No new prompt was sent");
    f.detach();
    await expect(listRoutines.run({ history_limit: 1 }, f.caller)).rejects.toThrow("scheduler is not available");
  });

  it("detaching an old scheduler does not remove its replacement", () => {
    const f = fixture();
    const replacement = { ...f.service };
    const detachReplacement = f.host.attachRoutines(replacement);
    f.detach();
    expect(f.host.requireRoutines()).toBe(replacement);
    detachReplacement();
    expect(() => f.host.requireRoutines()).toThrow("not available");
  });
});
