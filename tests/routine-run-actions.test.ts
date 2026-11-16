import { describe, expect, it, vi } from "vitest";
import { RoutineStopRequests, routineStopNotice, visibleRoutineRuns } from "../client/panel/routine-runs";
import type { Routine } from "../shared/bot";
import { routineCancelRunRpc, type RoutineRun } from "../shared/rpc";

const routine = (id: string): Routine => ({ id, name: id, prompt: "Check the inbox", enabled: true, schedule: { kind: "interval", minutes: 60 }, resultsChatId: null, createdAt: "2026-11-16T00:00:00Z" });
const run = (id: string, status: RoutineRun["status"] = "running", at = "2026-11-16T01:00:00Z"): RoutineRun => ({ id, status, trigger: "manual", agentId: `agent-${id}`, startedAt: at, scheduledFor: at, endedAt: status === "running" ? null : at, output: null, error: null });
const input = { botId: "bot-1", routineId: "routine-1", runId: "run-1" };

describe("routine stop controls", () => {
  it("submits the exact run once despite repeated clicks while allowing unrelated stops", async () => {
    const requests = new RoutineStopRequests();
    let finish!: (result: { run: RoutineRun; sessionReopened: boolean }) => void;
    const send = vi.fn(() => new Promise<{ run: RoutineRun; sessionReopened: boolean }>((resolve) => { finish = resolve; }));
    const pending = requests.request(input, send)!;
    expect(requests.request(input, send)).toBeNull();
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith(input);
    const other = vi.fn(async () => ({ run: run("run-2", "canceled"), sessionReopened: false }));
    await requests.request({ ...input, runId: "run-2" }, other);
    expect(other).toHaveBeenCalledOnce();
    finish({ run: run("run-1", "canceled"), sessionReopened: true });
    expect((await pending).run.status).toBe("canceled");
  });

  it("releases failed requests for a retry with the same ids without starting a new run", async () => {
    const requests = new RoutineStopRequests();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("host disconnected"))
      .mockResolvedValueOnce({ run: run("run-1", "canceled"), sessionReopened: false });
    await expect(requests.request(input, send)).rejects.toThrow("host disconnected");
    await expect(requests.request(input, send)).resolves.toMatchObject({ run: { id: "run-1", status: "canceled" } });
    expect(send.mock.calls).toEqual([[input], [input]]);
  });

  it("also releases synchronous failures and scopes guards to bot and routine", async () => {
    const requests = new RoutineStopRequests();
    const fail = () => { throw new Error("not connected"); };
    await expect(requests.request(input, fail)).rejects.toThrow("not connected");
    const send = vi.fn(async () => ({ run: run("run-1", "canceled"), sessionReopened: false }));
    const results = [requests.request(input, send), requests.request({ ...input, botId: "bot-2" }, send), requests.request({ ...input, routineId: "routine-2" }, send)];
    expect(results.every(Boolean)).toBe(true);
    await Promise.all(results);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("reports actual terminal outcomes when finishing races cancellation", () => {
    expect(routineStopNotice({ run: run("one", "canceled"), sessionReopened: true })).toMatchObject({ variant: "success", message: expect.stringContaining("conversation was reopened") });
    expect(routineStopNotice({ run: run("one", "succeeded"), sessionReopened: true })).toEqual({ message: "This run already finished successfully. Its schedule is unchanged." });
    expect(routineStopNotice({ run: { ...run("one", "failed"), error: "Provider unavailable" }, sessionReopened: false })).toEqual({ variant: "error", message: "This run already failed: Provider unavailable" });
    expect(routineStopNotice({ run: run("one"), sessionReopened: false })).toMatchObject({ variant: "error", message: expect.stringContaining("still active") });
    expect(routineStopNotice({ run: run("one", "skipped-busy"), sessionReopened: false }).message).toContain("no active turn");
  });

  it("keeps every active run visible ahead of newer history without exposing other routines", () => {
    const own = routine("own"), second = routine("second");
    const records = {
      own: { lastRunAt: null, runs: [run("old-active"), ...Array.from({ length: 12 }, (_, i) => run(`skip-${i}`, "skipped-busy", `2026-11-16T02:${String(i).padStart(2, "0")}:00Z`))] },
      second: { lastRunAt: null, runs: Array.from({ length: 12 }, (_, i) => run(`active-${i}`)) },
      unrelated: { lastRunAt: null, runs: [run("private")] },
    };
    const shown = visibleRoutineRuns([own, second], records, 10);
    expect(shown.filter(({ run }) => run.status === "running")).toHaveLength(13);
    expect(shown[0]?.run.id).toBe("old-active");
    expect(shown.filter(({ run }) => run.status !== "running")).toHaveLength(10);
    expect(shown[13]?.run.id).toBe("skip-11");
    expect(shown.some(({ run }) => run.id === "private")).toBe(false);
    expect(records.own.runs[0]?.id).toBe("old-active");
  });

  it("defines a strict cancellation RPC that cannot accept dispatch options", () => {
    expect(routineCancelRunRpc.input.parse(input)).toEqual(input);
    expect(routineCancelRunRpc.input.safeParse({ ...input, runId: "" }).success).toBe(false);
    expect(routineCancelRunRpc.input.safeParse({ ...input, prompt: "Start again" }).success).toBe(false);
    expect(routineCancelRunRpc.output.parse({ run: run("run-1", "succeeded"), sessionReopened: false }).run.status).toBe("succeeded");
  });
});
