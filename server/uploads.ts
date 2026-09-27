import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botDataPath } from "./bot-home";

export async function saveUpload({ botId, fileName, dataBase64 }: { botId: string; fileName: string; dataBase64: string }) {
  const safe = fileName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "") || "file";
  const dir = join(botDataPath(botId), "uploads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now().toString(36)}-${safe}`);
  const bytes = Buffer.from(dataBase64, "base64");
  await writeFile(path, bytes);
  return { path, size: bytes.length };
}
