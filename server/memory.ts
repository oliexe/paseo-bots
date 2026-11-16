import { appendFile, lstat, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { localDay, parseLog, type LogEntry } from "../shared/activity";
import { botDataPath } from "./bot-home";
import { ensureRealDirectory, missingFile, readRegularText } from "./files";

/** OpenMausBot's budget: the first 200 lines or 24 KB of MEMORY.md go into every chat. */
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 24_000;
export const MAIN_MEMORY = "MEMORY.md";
export const MAX_MEMORY_FILE_BYTES = 2 * 1024 * 1024;

export function memoryFolder(botId: string): string {
  return botDataPath(botId);
}

export function memoryFilePath(botId: string, name: string): string {
  if (!/^[A-Za-z0-9 ._-]+\.md$/.test(name) || name.length > 255) throw new Error("Invalid memory file name.");
  return name === MAIN_MEMORY ? join(botDataPath(botId), MAIN_MEMORY) : join(botDataPath(botId), "memory", name);
}

async function readText(path: string): Promise<string> {
  return (await readRegularText(path, MAX_MEMORY_FILE_BYTES)) ?? "";
}

async function topicNames(botId: string): Promise<string[]> {
  const directory = join(botDataPath(botId), "memory");
  const info = await lstat(directory).catch((error: unknown) => { if (missingFile(error)) return null; throw error; });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The memory folder must be a real directory.");
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^[A-Za-z0-9 ._-]+\.md$/.test(entry.name)).map((entry) => entry.name).sort();
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
    for (const name of await topicNames(botId)) {
      const path = memoryFilePath(botId, name);
      const text = await readText(path);
      files.push({ name, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, topic: true });
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
  const text = await readRegularText(memoryFilePath(botId, name), MAX_MEMORY_FILE_BYTES);
  return { text: text ?? "", revision: memoryRevision(text) };
}

export function memoryRevision(text: string | null): string | null {
  return text === null ? null : createHash("sha256").update(text).digest("hex");
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
  await ensureRealDirectory(botDataPath(botId), logFolder(botId));
  const existing = await lstat(logPath(botId, localDay(at))).catch((error: unknown) => { if (missingFile(error)) return null; throw error; });
  if (existing && !existing.isFile()) throw new Error("The daily log must be a regular file.");
  await appendFile(logPath(botId, localDay(at)), `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The log's days, newest first, with how many lines each has. */
export async function listLogDays(botId: string) {
  const info = await lstat(logFolder(botId)).catch((error: unknown) => { if (missingFile(error)) return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("The log folder must be a real directory.");
  const names = info ? (await readdir(logFolder(botId), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name) : [];
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
  for (const name of await topicNames(botId)) files.push({ path: `memory/${name}`, text: await readText(memoryFilePath(botId, name)) });
  for (const { day } of (await listLogDays(botId)).days) files.push({ path: `memory/log/${day}.md`, text: await readText(logPath(botId, day)) });
  return files.filter((file) => file.text);
}
