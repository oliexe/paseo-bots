import { describe, expect, it } from "vitest";
import type { Routine } from "../shared/bot";
import { mergeRoutineEdits } from "../shared/routine-edit";

const routine = (id: string): Routine => ({ id, name: id, prompt: "Check the inbox", enabled: true, schedule: { kind: "daily", time: "09:00", weekdays: [1] }, resultsChatId: null, createdAt: "2026-11-16T00:00:00Z" });

describe("routine form concurrency", () => {
  it("keeps separate rapid pause actions", () => {
    const before = [routine("first"), routine("second")];
    const first = [{ ...before[0]!, enabled: false }, before[1]!];
    const second = [before[0]!, { ...before[1]!, enabled: false }];
    expect(mergeRoutineEdits(first, before, second).map((item) => item.enabled)).toEqual([false, false]);
  });

  it("keeps a concurrent prompt edit while changing the schedule", () => {
    const before = [routine("inbox")];
    const current = [{ ...before[0]!, prompt: "Check unread messages only" }];
    const after = [{ ...before[0]!, schedule: { kind: "interval" as const, minutes: 30 } }];
    expect(mergeRoutineEdits(current, before, after)[0]).toMatchObject({ prompt: "Check unread messages only", schedule: { kind: "interval", minutes: 30 } });
    expect(before[0]!.prompt).toBe("Check the inbox");
  });

  it("does not resurrect deleted routines or discard a concurrent creation", () => {
    const before = [routine("old")];
    const current = [routine("elsewhere")];
    expect(mergeRoutineEdits(current, before, [{ ...before[0]!, enabled: false }])).toEqual(current);
    expect(mergeRoutineEdits(current, before, [routine("created")]).map((item) => item.id)).toEqual(["elsewhere", "created"]);
  });
});
