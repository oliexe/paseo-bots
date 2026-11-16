import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { LibrarySkill } from "../shared/bot";
import { parseSkillFrontmatter, parseSkillSource, sanitizeSkillName } from "../shared/skills";
import { botDataPath, botsHomePath, pluginDataPath } from "./bot-home";
import { atomicWrite, ensureRealDirectory, missingFile, readRegularText, safeFileParts } from "./files";

// The shared skill library: one folder per skill under plugin-data/library/skills.
// Bots that use the managed folder get a link to each of their skills in
// <bot>/skills, so the agent reads them inside its own working folder.

const MAX_SKILLS = 30;
const MAX_FILES_PER_SKILL = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LISTED_FILES = 100;

export type ImportedSkill = Pick<LibrarySkill, "id" | "description" | "source">;

function librarySkillsPath(): string {
  return join(pluginDataPath(), "library", "skills");
}

export function librarySkillPath(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === "." || id === "..") throw new Error("A skill name must be 1–128 letters, numbers, dots, dashes or underscores, and cannot be '.' or '..'.");
  return join(librarySkillsPath(), id);
}

async function fetchText(url: string, limit = MAX_FILE_BYTES): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref();
  try {
  const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "paseo-bots", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  if (!response.body) throw new Error(`${url} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error(`The download exceeds ${Math.round(limit / 1024)} KB: ${url}`);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
  } finally { clearTimeout(timeout); }
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url, 8 * 1024 * 1024)) as T;
}

const writes = new Map<string, Promise<unknown>>();
function changeSkill<T>(id: string, change: () => Promise<T>): Promise<T> {
  const key = librarySkillPath(id);
  const next = (writes.get(key) ?? Promise.resolve()).then(change);
  const settled = next.catch(() => {}).finally(() => { if (writes.get(key) === settled) writes.delete(key); });
  writes.set(key, settled);
  return next;
}

async function saveSkill(files: Map<string, string>, source: string, fallbackName: string): Promise<ImportedSkill> {
  if (!files.has("SKILL.md")) throw new Error("The skill is missing SKILL.md.");
  const meta = parseSkillFrontmatter(files.get("SKILL.md")!);
  const id = sanitizeSkillName(meta.name ?? fallbackName);
  const dir = librarySkillPath(id);
  await changeSkill(id, async () => {
    await mkdir(librarySkillsPath(), { recursive: true });
    const staged = join(librarySkillsPath(), `.import-${randomUUID()}`);
    const backup = join(librarySkillsPath(), `.backup-${randomUUID()}`);
    let backedUp = false;
    try {
      for (const [path, text] of files) {
        const target = join(staged, ...safeFileParts(path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
      }
      try { await rename(dir, backup); backedUp = true; } catch (error) { if (!missingFile(error)) throw error; }
      try { await rename(staged, dir); } catch (error) {
        if (backedUp) { await rename(backup, dir); backedUp = false; }
        throw error;
      }
      if (backedUp) { await rm(backup, { recursive: true, force: true }); backedUp = false; }
    } finally {
      await rm(staged, { recursive: true, force: true });
      // Leave a backup intact if an exceptional rollback failed.
    }
  });
  return { id, description: meta.description ?? "", source };
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

/** Fetches skills from "owner/repo", "owner/repo/path", a GitHub URL or a SKILL.md link into the library. */
export async function importSkills({ source: input }: { source: string }): Promise<{ skills: ImportedSkill[] }> {
  const source = parseSkillSource(input);
  if (source.kind === "raw") {
    const text = await fetchText(source.url);
    const fallback = posix.basename(posix.dirname(new URL(source.url).pathname)) || "skill";
    return { skills: [await saveSkill(new Map([["SKILL.md", text]]), source.url, fallback)] };
  }

  const { owner, repo } = source;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const ref = source.ref ?? (await fetchJson<{ default_branch: string }>(api)).default_branch;
  const tree = await fetchJson<{ tree: TreeEntry[]; truncated: boolean }>(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.truncated) throw new Error("This repository is too large to import safely. Use a direct SKILL.md link.");
  const prefix = source.path ? `${source.path}/` : "";
  const skillDirs = tree.tree
    .filter((entry) => entry.type === "blob" && posix.basename(entry.path) === "SKILL.md" && (entry.path === `${prefix}SKILL.md` || entry.path.startsWith(prefix)))
    .map((entry) => posix.dirname(entry.path));
  if (skillDirs.length > MAX_SKILLS) throw new Error(`This source contains more than ${MAX_SKILLS} skills. Select a smaller subfolder.`);
  if (skillDirs.length === 0) throw new Error(`No SKILL.md found in ${owner}/${repo}${source.path ? `/${source.path}` : ""}.`);

  const downloaded: { files: Map<string, string>; origin: string; name: string }[] = [];
  for (const dir of skillDirs) {
    const base = dir === "." ? "" : `${dir}/`;
    const blobs = tree.tree
      .filter((entry) => entry.type === "blob" && entry.path.startsWith(base))
      // Nested skills are imported on their own.
      .filter((entry) => !skillDirs.some((other) => other !== dir && other.startsWith(base) && entry.path.startsWith(`${other}/`)));
    if (blobs.length > MAX_FILES_PER_SKILL) throw new Error(`The skill ${dir} contains more than ${MAX_FILES_PER_SKILL} files. Use a direct SKILL.md link.`);
    const files = new Map<string, string>();
    for (const blob of blobs) {
      if ((blob.size ?? 0) > MAX_FILE_BYTES) throw new Error(`A skill file exceeds 512 KB: ${blob.path}`);
      const path = blob.path.slice(base.length);
      safeFileParts(path);
      files.set(path, await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${blob.path.split("/").map(encodeURIComponent).join("/")}`));
    }
    const origin = `github.com/${owner}/${repo}${dir === "." ? "" : `/${dir}`}`;
    downloaded.push({ files, origin, name: dir === "." ? repo : posix.basename(dir) });
  }
  const skills: ImportedSkill[] = [];
  for (const { files, origin, name } of downloaded) skills.push(await saveSkill(files, origin, name));
  return { skills };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return files.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of a library skill's SKILL.md, or null when it's missing. */
export async function skillSha(id: string): Promise<string | null> {
  const text = await readRegularText(join(librarySkillPath(id), "SKILL.md"), MAX_FILE_BYTES);
  return text === null ? null : sha256(text);
}

export async function readSkill({ id }: { id: string }) {
  const dir = librarySkillPath(id);
  const text = await readRegularText(join(dir, "SKILL.md"), MAX_FILE_BYTES);
  return { text: text ?? "", sha: text === null ? null : sha256(text), missing: text === null, path: join(dir, "SKILL.md"), files: await listFiles(dir) };
}

/** Writes SKILL.md, creating the skill folder if needed. Returns its frontmatter description and hash. */
export async function writeSkill({ id, text }: { id: string; text: string }) {
  const dir = librarySkillPath(id);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("A skill file must be at most 512 KB.");
  await changeSkill(id, async () => {
    await ensureRealDirectory(dir);
    await atomicWrite(join(dir, "SKILL.md"), text);
  });
  return { description: parseSkillFrontmatter(text).description ?? "", sha: sha256(text) };
}

export async function deleteSkill({ id }: { id: string }) {
  await changeSkill(id, () => rm(librarySkillPath(id), { recursive: true, force: true }));
  return { ok: true };
}

/**
 * Before the library, skills lived in each bot's skills folder. Moves them into
 * the library (the first copy of a name wins; later ones stay where they are).
 */
export async function migrateBotSkills(): Promise<void> {
  const bots = await readdir(botsHomePath(), { withFileTypes: true }).catch(() => []);
  for (const bot of bots) {
    if (!bot.isDirectory()) continue;
    const skillsDir = join(botsHomePath(), bot.name, "skills");
    const skills = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    for (const skill of skills) {
      if (!skill.isDirectory()) continue;
      const target = librarySkillPath(skill.name);
      if (await lstat(target).catch(() => null)) continue;
      await mkdir(librarySkillsPath(), { recursive: true });
      await rename(join(skillsDir, skill.name), target);
    }
  }
}

/**
 * Points <bot>/skills/<id> at each library skill the bot uses and removes links
 * to skills it no longer uses. Returns the SKILL.md path to give the agent for
 * each skill: the link, or the library copy when a link can't be made.
 */
export async function linkBotSkills(botId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const dir = join(botDataPath(botId), "skills");
  const paths = new Map<string, string>();
  await mkdir(dir, { recursive: true }).catch(() => {});
  const existing = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of existing) {
    if (entry.isSymbolicLink() && !ids.includes(entry.name)) await unlink(join(dir, entry.name)).catch(() => {});
  }
  for (const id of ids) {
    const target = librarySkillPath(id);
    const link = join(dir, id);
    const info = await lstat(link).catch(() => null);
    let linked = false;
    if (info?.isSymbolicLink()) {
      linked = (await readlink(link).catch(() => "")) === target;
      if (!linked) await unlink(link).catch(() => {});
    }
    if (!info || (info.isSymbolicLink() && !linked)) {
      // "junction" lets Windows link folders without admin rights; other systems ignore it.
      linked = await symlink(target, link, "junction").then(
        () => true,
        () => false,
      );
    }
    paths.set(id, join(linked ? link : target, "SKILL.md"));
  }
  return paths;
}
