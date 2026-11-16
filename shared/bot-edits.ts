import type { Bot } from "./bot";

export interface BotEdit { base: Bot; patch: Partial<Bot> }

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Merge only local changes into the newest saved value. Deletions win over stale edits. */
function merge(current: unknown, base: unknown, edited: unknown): unknown {
  if (equal(base, edited)) return current;
  if (Array.isArray(base) && Array.isArray(edited) && Array.isArray(current)) {
    const identified = [...base, ...edited, ...current].every((item) => object(item) && typeof item.id === "string");
    if (identified) {
      const before = new Map(base.map((item) => [item.id, item]));
      const after = new Map(edited.map((item) => [item.id, item]));
      const result = current.filter((item) => !before.has(item.id) || after.has(item.id)).map((item) => before.has(item.id) && after.has(item.id) ? merge(item, before.get(item.id), after.get(item.id)) : item);
      for (const item of edited) if (!before.has(item.id) && !current.some((saved) => saved.id === item.id)) result.push(item);
      return result;
    }
    if ([...base, ...edited, ...current].every((item) => item === null || typeof item !== "object")) {
      return [...current.filter((item) => !base.includes(item) || edited.includes(item)), ...edited.filter((item) => !base.includes(item) && !current.includes(item))];
    }
  }
  if (object(base) && object(edited) && object(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
      if (equal(base[key], edited[key])) continue;
      if (!(key in edited)) delete result[key];
      else result[key] = merge(current[key], base[key], edited[key]);
    }
    return result;
  }
  return edited;
}

export function mergeBotEdit(current: Bot, edit: BotEdit): Bot {
  const result = { ...current };
  for (const field of Object.keys(edit.patch) as (keyof Bot)[]) {
    if (field === "id" || field === "createdAt") continue;
    Object.assign(result, { [field]: merge(current[field], edit.base[field], edit.patch[field]) });
  }
  return result;
}
