import { z } from "zod";
import type { Routine, RoutineSchedule } from "./bot";
import { calendarMinute, dayOffsets, localTimeZone, shiftDay, validTimeZone, wallInstants, type CalendarDay } from "./routine-time";
export { localTimeZone, validTimeZone } from "./routine-time";

/** A run missed by more than this is skipped instead of caught up (OpenMausBot uses 12 hours). */
const CATCH_UP_MS = 12 * 60 * 60 * 1000;

/**
 * The most recent scheduled time at or before `now` that hasn't run yet, or
 * null. `since` is the last run (or the routine's creation when it never ran).
 */
export function latestDue(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(now.getTime())) return null;
  switch (schedule.kind) {
    case "webhook":
      return null;
    case "once": {
      const at = new Date(schedule.at);
      return at > since && at <= now ? at : null;
    }
    case "interval": {
      const period = schedule.minutes * 60_000;
      const elapsed = now.getTime() - since.getTime();
      return elapsed >= period ? new Date(since.getTime() + Math.floor(elapsed / period) * period) : null;
    }
    case "cron": {
      const cron = tryParseCron(schedule.expression);
      if (!cron) return null;
      const at = previousCronTime(cron, now, since, schedule.timeZone);
      return at && at > since ? at : null;
    }
    case "daily": {
      const zone = schedule.timeZone ?? localTimeZone();
      if (!validTimeZone(zone)) return null;
      const [hour, minute] = schedule.time.split(":").map(Number);
      const current = calendarMinute(now, zone);
      for (let back = 0; back <= 7; back++) {
        const day = shiftDay(current, -back);
        if (!schedule.weekdays.includes(day.weekday)) continue;
        const at = wallInstants(day, hour!, minute!, zone).reverse().find((value) => value <= now);
        if (at) return at > since ? at : null;
      }
      return null;
    }
  }
}

/** The next time the routine will fire after `now`, for display. */
export function nextRun(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(now.getTime())) return null;
  switch (schedule.kind) {
    case "webhook":
      return null;
    case "once": {
      const at = new Date(schedule.at);
      return at > since && at > now ? at : null;
    }
    case "interval": {
      const due = new Date(since.getTime() + schedule.minutes * 60_000);
      return due > now ? due : now;
    }
    case "cron": {
      const cron = tryParseCron(schedule.expression);
      return cron ? nextCronTime(cron, now, schedule.timeZone) : null;
    }
    case "daily": {
      const zone = schedule.timeZone ?? localTimeZone();
      if (!validTimeZone(zone)) return null;
      const [hour, minute] = schedule.time.split(":").map(Number);
      const current = calendarMinute(now, zone);
      for (let ahead = 0; ahead <= 7; ahead++) {
        const day = shiftDay(current, ahead);
        if (!schedule.weekdays.includes(day.weekday)) continue;
        const at = wallInstants(day, hour!, minute!, zone).find((value) => value > now);
        if (at) return at;
      }
      return null;
    }
  }
}

/** The next `count` times the schedule fires after `now` (an interval that's already due starts with `now`). */
export function upcomingRuns(schedule: RoutineSchedule, since: Date, now: Date, count: number): Date[] {
  const runs: Date[] = [];
  let from = since;
  let after = now;
  while (runs.length < Math.min(100, Math.max(0, Math.floor(count)))) {
    const next = nextRun(schedule, from, after);
    if (!next || (runs.length > 0 && next <= runs[runs.length - 1]!)) break;
    runs.push(next);
    from = next;
    after = next;
  }
  return runs;
}

/** "2026-09-27 09:00" in local time, the format the "At" field edits. */
export function formatLocalDateTime(date: Date, timeZone?: string): string {
  if (timeZone) {
    const at = calendarMinute(date, timeZone);
    return `${at.year}-${pad2(at.month)}-${pad2(at.day)} ${pad2(at.hour)}:${pad2(at.minute)}`;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Reads "YYYY-MM-DD HH:MM" (or with a T) as local time; null when it isn't a real date. */
export function parseLocalDateTime(text: string, timeZone?: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (timeZone) {
    if (!validTimeZone(timeZone)) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) return null;
    return wallInstants({ year, month, day, weekday: date.getUTCDay() }, hour, minute, timeZone)[0] ?? null;
  }
  const date = new Date(year, month - 1, day, hour, minute);
  const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
  return valid ? date : null;
}

export type RoutineDecision = { action: "run"; due: Date } | { action: "skip-missed"; due: Date } | { action: "wait" };

export function decide(routine: Routine, lastRunAt: string | null, now: Date): RoutineDecision {
  if (!routine.enabled) return { action: "wait" };
  const since = new Date(lastRunAt ?? routine.createdAt);
  const due = latestDue(routine.schedule, since, now);
  if (!due) return { action: "wait" };
  // Intervals coalesce missed slots into one run without replaying each missed
  // occurrence on successive ticks. The oldest missed slot sets catch-up age.
  const missedAt = routine.schedule.kind === "interval" ? since.getTime() + routine.schedule.minutes * 60_000 : due.getTime();
  return now.getTime() - missedAt <= CATCH_UP_MS ? { action: "run", due } : { action: "skip-missed", due };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "webhook":
      return "When its webhook is called";
    case "cron":
      return describeCron(schedule.expression) ?? schedule.expression.trim();
    case "once":
      return `Once at ${new Date(schedule.at).toLocaleString()}`;
    case "interval":
      return schedule.minutes % 60 === 0 ? `Every ${schedule.minutes / 60}h` : `Every ${schedule.minutes} min`;
    case "daily": {
      const days = [...schedule.weekdays].sort();
      const which =
        days.length === 7 ? "Every day" : days.join(",") === "1,2,3,4,5" ? "Weekdays" : days.map((day) => WEEKDAY_NAMES[day]).join(", ");
      return `${which} at ${schedule.time}`;
    }
  }
}

// ---------------------------------------------------------------- cron

// Five-field cron with Paseo's grammar (protocol/schedule/cron-expression.ts):
// numbers, "*", ranges "a-b", steps "/n" and comma lists; every field must match
// (no day-of-month/day-of-week OR rule). Routines read it in the host's local time.

/** Paseo's schedule cadence presets (schedules/schedule-cadence-options.ts). */
export const CRON_PRESETS: readonly { id: string; label: string; expression: string }[] = [
  { id: "every-minute", label: "Every minute", expression: "* * * * *" },
  { id: "every-hour", label: "Every hour", expression: "0 * * * *" },
  { id: "daily-9", label: "Daily 9:00", expression: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays 9:00", expression: "0 9 * * 1-5" },
  { id: "mondays-9", label: "Mondays 9:00", expression: "0 9 * * 1" },
];

export interface ParsedCron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
}

const CRON_FIELDS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
] as const;

function parseCronField(source: string, bounds: (typeof CRON_FIELDS)[number]): Set<number> {
  const allowed = new Set<number>();
  for (const rawPart of source.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid cron ${bounds.name} field`);
    const stepParts = part.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron ${bounds.name} step`);
    const [base = "", stepSource] = stepParts;
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (!Number.isInteger(step) || step <= 0 || (stepSource !== undefined && String(step) !== stepSource.trim())) {
      throw new Error(`Invalid cron ${bounds.name} step`);
    }
    let start: number;
    let end: number;
    const range = /^(\d+)-(\d+)$/.exec(base);
    if (base === "*") {
      start = bounds.min;
      end = bounds.max;
    } else if (range) {
      start = Number.parseInt(range[1]!, 10);
      end = Number.parseInt(range[2]!, 10);
      if (start > end || start < bounds.min || end > bounds.max) throw new Error(`Invalid cron ${bounds.name} range`);
    } else {
      if (!/^\d+$/.test(base)) throw new Error(`Invalid cron ${bounds.name} value`);
      start = Number.parseInt(base, 10);
      if (start < bounds.min || start > bounds.max) throw new Error(`Invalid cron ${bounds.name} value`);
      end = start;
    }
    for (let value = start; value <= end; value += step) allowed.add(value);
  }
  return allowed;
}

/** Throws with Paseo's messages ("Cron expressions must have 5 fields", "Invalid cron hour value", ...). */
function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expressions must have 5 fields");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseCronField(part, CRON_FIELDS[index]!));
  return { minute: minute!, hour: hour!, dayOfMonth: dayOfMonth!, month: month!, dayOfWeek: dayOfWeek! };
}

function tryParseCron(expression: string): ParsedCron | null {
  try {
    return parseCron(expression);
  } catch {
    return null;
  }
}

/** Paseo's form validation copy (utils/schedule-format.ts validateCron); null when valid. */
export function validateCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return "Enter a cron expression";
  try {
    parseCron(trimmed);
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : "Invalid cron expression").replace(/^Invalid cron /, "Invalid ");
  }
}

/** Far enough to reach a leap day. */
const CRON_SEARCH_DAYS = 4 * 366 + 1;

function sorted(values: ReadonlySet<number>, descending: boolean): number[] {
  return [...values].sort((a, b) => (descending ? b - a : a - b));
}

function dayMatches(cron: ParsedCron, day: CalendarDay): boolean {
  return cron.month.has(day.month) && cron.dayOfMonth.has(day.day) && cron.dayOfWeek.has(day.weekday);
}

function cronTime(cron: ParsedCron, at: Date, backwards: boolean, notBefore?: Date, timeZone = localTimeZone()): Date | null {
  if (!validTimeZone(timeZone)) return null;
  const current = calendarMinute(at, timeZone);
  const hours = sorted(cron.hour, backwards), minutes = sorted(cron.minute, backwards);
  const span = notBefore ? Math.min(CRON_SEARCH_DAYS, Math.max(0, Math.ceil((at.getTime() - notBefore.getTime()) / 86_400_000) + 1)) : CRON_SEARCH_DAYS;
  for (let offset = 0; offset <= span; offset++) {
    const day = shiftDay(current, backwards ? -offset : offset);
    if (!dayMatches(cron, day)) continue;
    const offsets = dayOffsets(day, timeZone);
    let found: Date | null = null;
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const candidate of wallInstants(day, hour, minute, timeZone, offsets)) {
          if (backwards ? candidate <= at : candidate > at) {
            if (!found || (backwards ? candidate > found : candidate < found)) found = candidate;
          }
        }
        // Ordinary days have one offset, and wall-clock order equals UTC order.
        if (found && offsets.length === 1) return found;
      }
    }
    if (found) return found;
  }
  return null;
}

function nextCronTime(cron: ParsedCron, after: Date, timeZone?: string): Date | null {
  return cronTime(cron, after, false, undefined, timeZone);
}
function previousCronTime(cron: ParsedCron, atOrBefore: Date, notBefore: Date, timeZone?: string): Date | null {
  return cronTime(cron, atOrBefore, true, notBefore, timeZone);
}

const CRON_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Humanizes the common shapes like Paseo's describeCron (utils/schedule-format.ts),
 * minus the time zone: routines always run in the host's local time. Null for
 * valid expressions it can't phrase (callers show the expression).
 */
export function describeCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (validateCron(trimmed) !== null) return null;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = trimmed.split(/\s+/);
  const dateWildcard = dayOfMonth === "*" && month === "*";
  if (minute === "*" && hour === "*" && dateWildcard && dayOfWeek === "*") return "Every minute";
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && dateWildcard && dayOfWeek === "*") return `Every ${everyMinutes[1]} minutes`;
  if (!/^\d+$/.test(minute) || !dateWildcard) return null;
  const minuteNumber = Number.parseInt(minute, 10);
  if (hour === "*") {
    if (dayOfWeek !== "*") return null;
    return minuteNumber === 0 ? "Every hour" : `Every hour at :${pad2(minuteNumber)}`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && dayOfWeek === "*") return minuteNumber === 0 ? `Every ${everyHours[1]} hours` : `Every ${everyHours[1]} hours at :${pad2(minuteNumber)}`;
  if (!/^\d+$/.test(hour)) return null;
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNumber)}`;
  let days: string | null = null;
  if (dayOfWeek === "*") days = "Daily";
  else if (dayOfWeek === "1-5") days = "Weekdays";
  else if (dayOfWeek === "0,6" || dayOfWeek === "6,0") days = "Weekends";
  else if (/^\d$/.test(dayOfWeek)) days = CRON_DAY_NAMES[Number.parseInt(dayOfWeek, 10)] ? `${CRON_DAY_NAMES[Number.parseInt(dayOfWeek, 10)]}s` : null;
  return days ? `${days} at ${time}` : null;
}

/**
 * The cron a routine's schedule reads as in the editor, like Paseo turning a
 * legacy interval into cron (normalizeScheduleFormCadence). Null for "once".
 */
export function scheduleToCron(schedule: RoutineSchedule): string | null {
  switch (schedule.kind) {
    case "cron":
      return schedule.expression;
    case "once":
    case "webhook":
      return null;
    case "daily": {
      const [hours = "9", minutes = "0"] = schedule.time.split(":");
      const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b).join(",");
      const dow = days === "0,1,2,3,4,5,6" ? "*" : days === "1,2,3,4,5" ? "1-5" : days || "*";
      return `${Number(minutes)} ${Number(hours)} * * ${dow}`;
    }
    case "interval": {
      const { minutes } = schedule;
      if (minutes < 60) return `*/${minutes} * * * *`;
      const hours = Math.round(minutes / 60);
      if (hours >= 24) return "0 9 * * *";
      return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
    }
  }
}

// ---------------------------------------------------------------- tool input

/** A routine schedule as bots give it in tool calls. */
export const ScheduleInput = z.object({
  type: z.enum(["once", "daily", "cron", "interval", "webhook"]),
  at: z.string().max(40).optional().describe('For "once": local date and time, "YYYY-MM-DD HH:MM".'),
  time: z.string().max(5).optional().describe('For "daily": local time, "HH:MM".'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('For "daily": the days to run, 0 = Sunday to 6 = Saturday. Every day when left out.'),
  expression: z.string().max(100).optional().describe('For "cron": five fields (minute hour day-of-month month day-of-week) in local time.'),
  timeZone: z.string().max(100).optional().describe("IANA time zone for daily/cron/once, for example Europe/Prague. Omit to use the host zone."),
  every_minutes: z.number().int().min(5).max(1440).optional().describe('For "interval": minutes between runs, 5 to 1440.'),
});

/** The routine schedule a tool call describes; throws a message the bot can act on. */
export function scheduleFrom(input: z.infer<typeof ScheduleInput>, now: Date): RoutineSchedule {
  if (input.timeZone && !validTimeZone(input.timeZone)) throw new Error("Use a valid IANA time zone, for example Europe/Prague.");
  const zone = input.timeZone ? { timeZone: input.timeZone } : {};
  switch (input.type) {
    case "once": {
      const at = input.at ? (parseLocalDateTime(input.at, input.timeZone) ?? (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(input.at) ? new Date(input.at) : new Date(NaN))) : null;
      if (!at || Number.isNaN(at.getTime())) throw new Error('A "once" routine needs "at" as "YYYY-MM-DD HH:MM".');
      if (at <= now) throw new Error(`${input.at} has already passed. Pick a time in the future.`);
      return { kind: "once", at: at.toISOString() };
    }
    case "daily": {
      if (!input.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('A "daily" routine needs "time" as "HH:MM".');
      const weekdays = [...new Set(input.weekdays ?? [0, 1, 2, 3, 4, 5, 6])].sort();
      if (weekdays.length === 0) throw new Error("Give at least one weekday.");
      return { kind: "daily", time: input.time, weekdays, ...zone };
    }
    case "cron": {
      const error = validateCron(input.expression ?? "");
      if (error) throw new Error(`${error}. Use five fields: minute hour day-of-month month day-of-week.`);
      return { kind: "cron", expression: input.expression!.trim(), ...zone };
    }
    case "interval":
      if (!Number.isInteger(input.every_minutes) || input.every_minutes! < 5 || input.every_minutes! > 1440) throw new Error('An "interval" routine needs "every_minutes" (5 to 1440).');
      return { kind: "interval", minutes: input.every_minutes! };
    case "webhook":
      return { kind: "webhook" };
  }
}
