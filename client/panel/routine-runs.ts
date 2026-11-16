import type { Routine } from "../../shared/bot";
import type { RoutineRecord, RoutineRun } from "../../shared/rpc";

export interface StopRunInput { botId: string; routineId: string; runId: string; }
export interface StopRunResult { run: RoutineRun; sessionReopened: boolean; }

/** One local request per exact run, released after both success and failure. */
export class RoutineStopRequests {
  private readonly pending = new Set<string>();

  request(input: StopRunInput, send: (input: StopRunInput) => Promise<StopRunResult>): Promise<StopRunResult> | null {
    const key = JSON.stringify([input.botId, input.routineId, input.runId]);
    if (this.pending.has(key)) return null;
    this.pending.add(key);
    return Promise.resolve().then(() => send(input)).finally(() => { this.pending.delete(key); });
  }
}

/** An old active run must remain stoppable even after many newer skips. */
export function visibleRoutineRuns(routines: readonly Routine[], records: Record<string, RoutineRecord>, recentLimit: number) {
  const entries = routines.flatMap((routine) => (records[routine.id]?.runs ?? []).map((run) => ({ run, routine })));
  const sorted = entries.sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt));
  return [...sorted.filter(({ run }) => run.status === "running"), ...sorted.filter(({ run }) => run.status !== "running").slice(0, recentLimit)];
}

/** Reflect the authoritative outcome: a run can complete while Stop is in flight. */
export function routineStopNotice(result: StopRunResult): { message: string; variant?: "success" | "error" } {
  switch (result.run.status) {
    case "canceled": return { message: result.sessionReopened ? "Run stopped. Its conversation was reopened; its schedule is unchanged." : "Run stopped. Its schedule is unchanged.", variant: "success" };
    case "succeeded": return { message: "This run already finished successfully. Its schedule is unchanged." };
    case "failed": return { message: `This run already failed${result.run.error ? `: ${result.run.error}` : "."}`, variant: "error" };
    case "skipped-busy":
    case "skipped-missed": return { message: "This run was skipped; there is no active turn to stop." };
    case "running": return { message: "The run is still active. Check its conversation and try stopping it again.", variant: "error" };
  }
}
