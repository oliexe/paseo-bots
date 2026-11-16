import type { RoutineRecord, RoutineRun } from "../shared/rpc";

/** The scoped tool surface borrows the host's scheduler; it never creates its own timer. */
export interface RoutineService {
  status(): Promise<{ scheduler: boolean; timeZone: string; error: string | null; routines: Record<string, RoutineRecord> }>;
  runNow(botId: string, routineId: string, requestKey?: string): Promise<{ run: RoutineRun }>;
  cancelRun(botId: string, routineId: string, runId: string): Promise<{ run: RoutineRun; sessionReopened: boolean }>;
}
