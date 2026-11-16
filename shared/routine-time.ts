/** Wall-clock scheduling without depending on the phone's or browser's zone.
 * A skipped DST minute has no candidates; a repeated minute has both instants. */
export interface CalendarDay { year: number; month: number; day: number; weekday: number }
interface CalendarMinute extends CalendarDay { hour: number; minute: number }
const formatters = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return true; }
  catch { return false; }
}

export function localTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}

export function calendarMinute(at: Date, zone = localTimeZone()): CalendarMinute {
  const parts = Object.fromEntries(formatter(zone).formatToParts(at).map(({ type, value }) => [type, value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), hour: Number(parts.hour), minute: Number(parts.minute) };
}

export function shiftDay(day: CalendarDay, count: number): CalendarDay {
  const at = new Date(Date.UTC(day.year, day.month - 1, day.day + count));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate(), weekday: at.getUTCDay() };
}

/** Offsets either side of this date include both sides of a daylight-saving change. */
export function dayOffsets(day: CalendarDay, zone = localTimeZone()): number[] {
  const noon = Date.UTC(day.year, day.month - 1, day.day, 12);
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const timestamp = noon + hours * 3_600_000;
    const wall = calendarMinute(new Date(timestamp), zone);
    offsets.add(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - timestamp);
  }
  return [...offsets];
}

export function wallInstants(day: CalendarDay, hour: number, minute: number, zone = localTimeZone(), offsets = dayOffsets(day, zone)): Date[] {
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  return offsets.map((offset) => new Date(wall - offset)).filter((at) => {
    const value = calendarMinute(at, zone);
    return value.year === day.year && value.month === day.month && value.day === day.day && value.hour === hour && value.minute === minute;
  }).sort((a, b) => a.getTime() - b.getTime());
}
