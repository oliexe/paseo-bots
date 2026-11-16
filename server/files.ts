import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** A bounded, regular-file read. Never follows a file's symbolic link. */
export async function readRegularText(path: string, limit: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > limit) throw new Error(`File exceeds the ${Math.round(limit / 1024)} KB limit: ${path}`);
    // The file may grow after stat. Read at most limit + 1 bytes even then.
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit || offset > info.size) throw new Error(`File changed while it was being read: ${path}`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Write alongside the destination and replace it only after the full write succeeds. */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Ensure imported paths cannot traverse a symlink already on the host. */
export async function ensureRealDirectory(root: string, directory = root): Promise<void> {
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("The file path is outside its folder.");
  const paths = [root];
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) paths.push((current = join(current, part)));
  for (const path of paths) {
    const info = await lstat(path).catch((error: unknown) => {
      if (missingFile(error)) return null;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Expected a folder, not a link or file: ${path}`);
    if (!info) await mkdir(path, { recursive: true });
  }
}

export function safeFileParts(path: string): string[] {
  const parts = path.split("/");
  if (!path || path.includes("\\") || path.includes("\0") || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid file path: ${path}`);
  return parts;
}
