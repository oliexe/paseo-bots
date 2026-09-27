import type { Routine, RoutineSchedule } from "./bot";

/** A run missed by more than this is skipped instead of caught up (OpenMausBot uses 12 hours). */
export const CATCH_UP_MS = 12 * 60 * 60 * 1000;

function atLocalTime(day: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const at = new Date(day);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

/**
 * The most recent scheduled time at or before `now` that hasn't run yet, or
 * null. `since` is the last run (or the routine's creation when it never ran).
 */
export function latestDue(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at > since && at <= now ? at : null;
    }
    case "interval": {
      const due = new Date(since.getTime() + schedule.minutes * 60_000);
      return due <= now ? due : null;
    }
    case "cron": {
      const cron = tryParseCron(schedule.expression);
      if (!cron) return null;
      const at = previousCronTime(cron, now, since);
      return at && at > since ? at : null;
    }
    case "daily": {
      for (let back = 0; back <= 7; back++) {
        const day = new Date(now);
        day.setDate(now.getDate() - back);
        if (!schedule.weekdays.includes(day.getDay())) continue;
        const at = atLocalTime(day, schedule.time);
        if (at > now) continue;
        return at > since ? at : null;
      }
      return null;
    }
  }
}

/** The next time the routine will fire after `now`, for display. */
export function nextRun(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  switch (schedule.kind) {
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
      return cron ? nextCronTime(cron, now) : null;
    }
    case "daily": {
      if (schedule.weekdays.length === 0) return null;
      for (let ahead = 0; ahead <= 7; ahead++) {
        const day = new Date(now);
        day.setDate(now.getDate() + ahead);
        if (!schedule.weekdays.includes(day.getDay())) continue;
        const at = atLocalTime(day, schedule.time);
        if (at > now) return at;
      }
      return null;
    }
  }
}

export type RoutineDecision = { action: "run"; due: Date } | { action: "skip-missed"; due: Date } | { action: "wait" };

export function decide(routine: Routine, lastRunAt: string | null, now: Date): RoutineDecision {
  if (!routine.enabled) return { action: "wait" };
  const since = new Date(lastRunAt ?? routine.createdAt);
  const due = latestDue(routine.schedule, since, now);
  if (!due) return { action: "wait" };
  return now.getTime() - due.getTime() <= CATCH_UP_MS ? { action: "run", due } : { action: "skip-missed", due };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
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
export function parseCron(expression: string): ParsedCron {
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

function dayMatches(cron: ParsedCron, day: Date): boolean {
  return cron.month.has(day.getMonth() + 1) && cron.dayOfMonth.has(day.getDate()) && cron.dayOfWeek.has(day.getDay());
}

/** The first matching minute strictly after `after`, or null within four years. */
export function nextCronTime(cron: ParsedCron, after: Date): Date | null {
  const hours = sorted(cron.hour, false);
  const minutes = sorted(cron.minute, false);
  for (let offset = 0; offset <= CRON_SEARCH_DAYS; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!dayMatches(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (at > after) return at;
      }
    }
  }
  return null;
}

/** The latest matching minute at or before `atOrBefore`, searching back no further than `notBefore`'s day. */
export function previousCronTime(cron: ParsedCron, atOrBefore: Date, notBefore: Date): Date | null {
  const hours = sorted(cron.hour, true);
  const minutes = sorted(cron.minute, true);
  const span = Math.min(CRON_SEARCH_DAYS, Math.max(0, Math.ceil((atOrBefore.getTime() - notBefore.getTime()) / 86_400_000) + 1));
  for (let offset = 0; offset <= span; offset++) {
    const day = new Date(atOrBefore.getFullYear(), atOrBefore.getMonth(), atOrBefore.getDate() - offset);
    if (!dayMatches(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (at <= atOrBefore) return at;
      }
    }
  }
  return null;
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
