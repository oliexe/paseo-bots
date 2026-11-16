import type { Routine } from "./bot";

/** Apply only the fields a form changed, preserving other edits saved while it was open. */
export function mergeRoutineEdits(current: Routine[], before: Routine[], after: Routine[]): Routine[] {
  const old = new Map(before.map((routine) => [routine.id, routine]));
  const edited = new Map(after.map((routine) => [routine.id, routine]));
  const result = current.filter((routine) => !old.has(routine.id) || edited.has(routine.id)).map((routine) => {
    const previous = old.get(routine.id);
    const next = edited.get(routine.id);
    if (!previous || !next) return routine;
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof Routine])));
    return { ...routine, ...changed };
  });
  const saved = new Set(result.map((routine) => routine.id));
  // A routine deleted elsewhere stays deleted. Only newly created IDs are appended.
  return [...result, ...after.filter((routine) => !old.has(routine.id) && !saved.has(routine.id))];
}
