import { lstatSync, renameSync, symlinkSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The plugin SDK has no data-directory API; other plugins use
// `$PASEO_HOME/plugin-data/<plugin-id>`, so this follows that convention.
function pluginDataRoot(): string {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data");
}

export function pluginDataPath(): string {
  return join(pluginDataRoot(), "paseo-bots");
}

/**
 * The plugin was called paseo-bot before. Move its data (bots' folders, the
 * skill library, the Composio key) to the new name and leave a link behind,
 * so chats started in the old folders keep their working directory. Runs
 * once, synchronously, before anything reads the data folder.
 */
export function migrateRenamedPluginData(): void {
  const legacy = join(pluginDataRoot(), "paseo-bot");
  const target = pluginDataPath();
  try {
    if (!lstatSync(legacy).isDirectory()) return;
  } catch {
    return;
  }
  try {
    lstatSync(target);
    return;
  } catch {
    // No data under the new name yet: move the old folder over.
  }
  renameSync(legacy, target);
  symlinkSync(target, legacy, "junction");
}

/**
 * One folder for every bot that uses the managed folder. Paseo files each agent
 * under the workspace of its folder, so sharing it keeps all bot chats in a
 * single workspace; Paseo names the project after the folder, hence "Bots".
 */
export function botsHomePath(): string {
  // Nested because macOS folders are case-insensitive and "bots" held per-bot folders in v0.1.
  return join(pluginDataPath(), "shared", "Bots");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

let migration: Promise<void> | null = null;

/**
 * Earlier versions used a folder called "home", which Paseo showed as a "home"
 * project. Move it to "Bots" and leave a link behind so existing chats keep
 * their working folder.
 */
export function migrateLegacyHome(): Promise<void> {
  migration ??= (async () => {
    const legacy = join(pluginDataPath(), "home");
    const target = botsHomePath();
    const info = await lstat(legacy).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || (await exists(target))) return;
    await mkdir(join(target, ".."), { recursive: true });
    await rename(legacy, target);
    await symlink(target, legacy, "dir");
  })().catch((error: unknown) => console.error("paseo-bots: couldn't move the bots folder", error));
  return migration;
}

/**
 * Each bot's own folder: the working folder of its workspace, and where its
 * memory, skills and uploads live so its chats can read and update them.
 */
export function botDataPath(botId: string): string {
  return join(botsHomePath(), botId);
}

/**
 * Paseo shows an icon.svg in a project's folder as the project icon. The Bots project gets
 * the plugin's sidebar glyph (Lucide's Bot) in white on a tile shaped and coloured like the
 * project icons Paseo draws itself (project-icon-view.tsx: 25% corners, the muted identity
 * blue), so it reads on light and dark themes alike.
 */
const PROJECT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5179b0"/><g transform="translate(12.8 12.8) scale(1.6)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g></svg>`;

export async function ensureBotsHome() {
  await migrateLegacyHome();
  const path = botsHomePath();
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "paseo-bots: one folder per bot, each the working folder of that bot's workspace.\n", { flag: "w" });
  await writeFile(join(path, "icon.svg"), PROJECT_ICON, { flag: "w" });
  return { path };
}

/** Moves data kept under `.bots/<id>` by the previous version into the bot's own folder. */
async function adoptLegacyData(botId: string, target: string): Promise<void> {
  const legacy = join(botsHomePath(), ".bots", botId);
  const names = await readdir(legacy).catch(() => null);
  if (!names) return;
  for (const name of names) {
    const destination = join(target, name);
    if (!(await exists(destination))) await rename(join(legacy, name), destination);
  }
  await rm(legacy, { recursive: true, force: true });
}

export async function ensureBotHome({ botId }: { botId: string }) {
  const { path: root } = await ensureBotsHome();
  const path = botDataPath(botId);
  await mkdir(path, { recursive: true });
  await adoptLegacyData(botId, path);
  return { root, path };
}
