// A bot's daily log and recent-work brief, after OpenMausBot's memory/log and
// recent-work.ts. The app writes one line per finished turn to
// memory/log/YYYY-MM-DD.md; the newest line from each chat of the last two days
// goes into the next chat's prompt.

import { toolCallName } from "./tool-name";

const REPLY_MAX = 240;
const TITLE_MAX = 60;
const MAX_TOOLS = 6;
const BRIEF_HOURS = 48;
const BRIEF_LINES = 10;
const BRIEF_CHARS = 1_400;
const BRIEF_QUOTE_MAX = 160;

/** One line of whitespace-collapsed text, cut to `max` characters. */
export function foldText(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Hides common credential formats before text is written to disk. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|ak|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, "$1 [redacted]");
}

/** "mcp__bots__ask_bot" and "bots.ask_bot" read as "bots/ask_bot"; built-in tools keep their names. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}

interface TimelineItemLike {
  type: string;
  text?: unknown;
  name?: unknown;
  metadata?: unknown;
}

/** The latest turn in a chat's timeline: the bot's last reply and the tools it used. */
export function lastTurn(items: readonly TimelineItemLike[]): { reply: string; tools: string[] } {
  let start = items.length;
  while (start > 0 && items[start - 1]!.type !== "user_message") start--;
  const turn = items.slice(start);
  const reply = [...turn].reverse().find((item) => item.type === "assistant_message" && String(item.text ?? "").trim());
  const tools: string[] = [];
  for (const item of turn) {
    if (item.type !== "tool_call" || typeof item.name !== "string") continue;
    const label = toolLabel(toolCallName({ name: item.name, metadata: item.metadata }));
    if (!tools.includes(label) && tools.length < MAX_TOOLS) tools.push(label);
  }
  return { reply: String(reply?.text ?? ""), tools };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the host's time zone. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One daily-log line: "- 09:05 · from chat "Title" · reply [tools: a, b]".
 * Null for a turn that finished without saying anything.
 */
export function logLine(input: { at: Date; chat: string; reply: string; tools: readonly string[]; failure?: string | null }): string | null {
  const reply = foldText(redactSecrets(input.reply), REPLY_MAX);
  const failure = input.failure ? `(turn failed: ${foldText(input.failure, 120)})` : "";
  if (!reply && !failure) return null;
  const tools = input.tools.length ? `[tools: ${input.tools.join(", ")}]` : "";
  const text = [reply, tools, failure].filter(Boolean).join(" ");
  return `- ${localTime(input.at)} · from chat "${foldText(input.chat.replace(/"/g, "'"), TITLE_MAX)}" · ${text}`;
}

export interface LogEntry {
  /** Local date and time of the turn. */
  at: Date;
  chat: string;
  text: string;
}

const LOG_LINE = /^- (\d{2}):(\d{2}) · from chat "([^"]*)" · (.*)$/;

/** The lines of one day's log file (YYYY-MM-DD.md); lines the bot wrote in another shape are skipped. */
export function parseLog(day: string, text: string): LogEntry[] {
  const [year, month, date] = day.split("-").map(Number);
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const match = LOG_LINE.exec(line.trim());
    if (!match || !year || !month || !date) continue;
    entries.push({ at: new Date(year, month - 1, date, Number(match[1]), Number(match[2])), chat: match[3]!, text: match[4]! });
  }
  return entries;
}

function dayLabel(at: Date, now: Date): string {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const day = localDay(at);
  return day === today ? "today" : day === yesterday ? "yesterday" : day;
}

/**
 * OpenMausBot's recent-work brief: the newest thing the bot said in each chat
 * over the last two days, newest first, within 10 lines and 1,400 characters.
 */
export function recentWork(entries: readonly LogEntry[], now: Date): string[] {
  const since = now.getTime() - BRIEF_HOURS * 3_600_000;
  const newest = new Map<string, LogEntry>();
  for (const entry of entries) {
    if (entry.at.getTime() < since || entry.text.startsWith("(turn failed")) continue;
    const seen = newest.get(entry.chat);
    if (!seen || seen.at <= entry.at) newest.set(entry.chat, entry);
  }
  const lines: string[] = [];
  let length = 0;
  for (const entry of [...newest.values()].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    const said = foldText(entry.text.replace(/\s*\[tools: [^\]]*\]/, ""), BRIEF_QUOTE_MAX);
    const line = `- ${whenLabel(entry.at, now)} · "${entry.chat}" · you said: "${said}"`;
    if (lines.length >= BRIEF_LINES || length + line.length > BRIEF_CHARS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines;
}

// ---------------------------------------------------------------- search

const STOP_WORDS = new Set("a an and are about as at be by did do does for from how i in is it me my of on or our that the this to was we were what when where which who why with you your".split(" "));

/** The content words of a search: lowercase, without filler words. Every one must match. */
export function searchWords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._@-]*/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
}

export function matchesAll(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/** About `max` characters around the first match, with the matched words in [brackets]. */
export function snippet(text: string, words: readonly string[], max = 240): string {
  const line = text.replace(/\s+/g, " ").trim();
  const lower = line.toLowerCase();
  const first = words.length ? Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0)) : 0;
  const start = Number.isFinite(first) ? Math.max(0, first - Math.floor(max / 3)) : 0;
  let cut = line.slice(start, start + max);
  if (start > 0) cut = `…${cut}`;
  if (start + max < line.length) cut = `${cut}…`;
  if (words.length === 0) return cut;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return cut.replace(pattern, "[$1]");
}

/** "24h", "3d", "2w", "today", "yesterday" or a date (YYYY-MM-DD) as the moment it starts. */
export function parseSince(text: string, now: Date): Date {
  const value = text.trim().toLowerCase();
  const midnight = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  if (value === "today") return midnight(0);
  if (value === "yesterday") return midnight(1);
  const span = /^(\d+)\s*(h|d|w)$/.exec(value);
  if (span) return new Date(now.getTime() - Number(span[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[span[2] as "h" | "d" | "w"]);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  throw new Error(`Couldn't read "${text}" as a time. Use 24h, 3d, 2w, today, yesterday or a date like 2026-09-01.`);
}

/** "today 09:05", "yesterday 17:40" or "2026-09-20 08:00". */
export function whenLabel(at: Date, now: Date): string {
  return `${dayLabel(at, now)} ${localTime(at)}`;
}

// ---------------------------------------------------------------- journal wording

interface JournalRowLike {
  file: string;
  actor: "bot" | "you";
  via: "chat" | "app" | "disk" | "undo";
  chat: { title: string } | null;
  kind: "created" | "edited" | "deleted";
  added: number;
  removed: number;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "Scout added 2 lines to MEMORY.md", "You deleted the clients topic" (OpenMausBot's journalSummary). */
export function journalSummary(row: JournalRowLike, botName: string): string {
  const who = row.actor === "bot" ? botName : "You";
  const target = row.file === "MEMORY.md" ? "MEMORY.md" : `the ${row.file.replace(/\.md$/, "")} topic`;
  if (row.kind === "created") return `${who} created ${target}${row.added ? ` with ${plural(row.added, "line")}` : ""}`;
  if (row.kind === "deleted") return `${who} deleted ${target}`;
  if (row.added && !row.removed) return `${who} added ${plural(row.added, "line")} to ${target}`;
  if (row.removed && !row.added) return `${who} removed ${plural(row.removed, "line")} from ${target}`;
  return `${who} rewrote ${plural(Math.max(row.added, row.removed), "line")} in ${target}`;
}

/** Where a change came from. */
export function journalSource(row: JournalRowLike): string {
  if (row.via === "undo") return "undo";
  if (row.via === "disk") return "changed outside the app";
  if (row.chat) return `from chat "${row.chat.title}"`;
  return "in the bot's settings";
}

/** "Today", "Yesterday" or "Sat, Sep 26" for a log day (YYYY-MM-DD). */
export function dayName(day: string, now: Date): string {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(year!, month! - 1, date!);
  const label = dayLabel(at, now);
  if (label === "today") return "Today";
  if (label === "yesterday") return "Yesterday";
  return at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
