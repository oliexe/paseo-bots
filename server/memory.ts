import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botDataPath } from "./bot-home";

/** OpenMausBot's budget: the first 200 lines or 24 KB of MEMORY.md go into every chat. */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 24_000;
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

export function trimForPrompt(text: string): string {
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

export async function writeMemory(botId: string, name: string, text: string) {
  const path = memoryFilePath(botId, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  return { ok: true };
}

export async function deleteMemory(botId: string, name: string) {
  await rm(memoryFilePath(botId, name), { force: true });
  return { ok: true };
}
