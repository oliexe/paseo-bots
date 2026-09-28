import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDay, parseLog, type LogEntry } from "../shared/activity";
import { botDataPath } from "./bot-home";

/** OpenMausBot's budget: the first 200 lines or 24 KB of MEMORY.md go into every chat. */
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 24_000;
export const MAIN_MEMORY = "MEMORY.md";

export function memoryFolder(botId: string): string {
  return botDataPath(botId);
}

export function memoryFilePath(botId: string, name: string): string {
  return name === MAIN_MEMORY ? join(botDataPath(botId), MAIN_MEMORY) : join(botDataPath(botId), "memory", name);
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function trimForPrompt(text: string): string {
  const lines = text.split("\n").slice(0, MEMORY_MAX_LINES);
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (Buffer.byteLength(next, "utf8") > MEMORY_MAX_BYTES) break;
    out = next;
  }
  return out;
}

export async function injectedMemory(botId: string): Promise<string> {
  return trimForPrompt(await readText(memoryFilePath(botId, MAIN_MEMORY)));
}

export async function listMemory(botId: string) {
  const files: { name: string; bytes: number; lines: number; topic: boolean }[] = [];
  const main = await readText(memoryFilePath(botId, MAIN_MEMORY));
  files.push({ name: MAIN_MEMORY, bytes: Buffer.byteLength(main, "utf8"), lines: main ? main.split("\n").length : 0, topic: false });
  try {
    for (const name of (await readdir(join(botDataPath(botId), "memory"))).sort()) {
      if (!name.endsWith(".md")) continue;
      const path = join(botDataPath(botId), "memory", name);
      if (!(await stat(path)).isFile()) continue;
      const text = await readText(path);
      files.push({ name, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, topic: true });
    }
  } catch {
    // No topic files yet.
  }
  const injected = trimForPrompt(main);
  return {
    folder: botDataPath(botId),
    files,
    injectedLines: injected ? injected.split("\n").length : 0,
    injectedBytes: Buffer.byteLength(injected, "utf8"),
  };
}

export async function readMemory(botId: string, name: string) {
  return { text: await readText(memoryFilePath(botId, name)) };
}

// ---------------------------------------------------------------- daily log

const LOG_DAY = /^\d{4}-\d{2}-\d{2}$/;

function logFolder(botId: string): string {
  return join(botDataPath(botId), "memory", "log");
}

function logPath(botId: string, day: string): string {
  if (!LOG_DAY.test(day)) throw new Error(`Not a log day: ${day}`);
  return join(logFolder(botId), `${day}.md`);
}

/** Adds a line to today's log, memory/log/YYYY-MM-DD.md. */
export async function appendDailyLog(botId: string, line: string, at = new Date()): Promise<void> {
  await mkdir(logFolder(botId), { recursive: true });
  await appendFile(logPath(botId, localDay(at)), `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The log's days, newest first, with how many lines each has. */
export async function listLogDays(botId: string) {
  const names = await readdir(logFolder(botId)).catch(() => [] as string[]);
  const days = names.filter((name) => LOG_DAY.test(name.replace(/\.md$/, "")) && name.endsWith(".md")).map((name) => name.replace(/\.md$/, ""));
  const out: { day: string; lines: number }[] = [];
  for (const day of days.sort().reverse()) {
    const text = await readText(logPath(botId, day));
    out.push({ day, lines: text.split("\n").filter((line) => line.trim()).length });
  }
  return { days: out };
}

export async function readLogDay(botId: string, day: string) {
  return { text: await readText(logPath(botId, day)) };
}

export async function deleteLogDay(botId: string, day: string) {
  await rm(logPath(botId, day), { force: true });
  return { ok: true };
}

/** Log entries from the last `days` days (today included), oldest first. */
export async function recentLogEntries(botId: string, days: number, now = new Date()): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    entries.push(...parseLog(day, await readText(logPath(botId, day))));
  }
  return entries;
}

/** Every memory file with its text, as the bot sees the paths: MEMORY.md, memory/<topic>.md and memory/log/<day>.md. */
export async function memoryTexts(botId: string): Promise<{ path: string; text: string }[]> {
  const files = [{ path: MAIN_MEMORY, text: await readText(memoryFilePath(botId, MAIN_MEMORY)) }];
  const topics = await readdir(join(botDataPath(botId), "memory")).catch(() => [] as string[]);
  for (const name of topics.filter((entry) => entry.endsWith(".md")).sort()) files.push({ path: `memory/${name}`, text: await readText(memoryFilePath(botId, name)) });
  for (const { day } of (await listLogDays(botId)).days) files.push({ path: `memory/log/${day}.md`, text: await readText(logPath(botId, day)) });
  return files.filter((file) => file.text);
}
