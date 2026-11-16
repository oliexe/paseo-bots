import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { botDataPath } from "./bot-home";
import { ensureRealDirectory } from "./files";

export async function saveUpload({ botId, fileName, dataBase64 }: { botId: string; fileName: string; dataBase64: string }) {
  const safe = fileName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").slice(-180) || "file";
  const dir = join(botDataPath(botId), "uploads");
  const padding = dataBase64.indexOf("=");
  const end = padding === -1 ? dataBase64.length : padding;
  if (dataBase64.length > 36_000_000 || dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(dataBase64.slice(0, end)) || (padding !== -1 && (end < dataBase64.length - 2 || !/^={1,2}$/.test(dataBase64.slice(end))))) {
    throw new Error("The attachment must be valid base64 and at most 27 MB.");
  }
  await ensureRealDirectory(botDataPath(botId), dir);
  const path = join(dir, `${randomUUID()}-${safe}`);
  const bytes = Buffer.from(dataBase64, "base64");
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, size: bytes.length };
}
