import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { BotMcpServerSchema, BotSchema, botMcpServers, botSkills, newRoutineId, type Bot, type BotMcpServer, type Library } from "../shared/bot";
import { sanitizeSkillName } from "../shared/skills";
import { botDataPath } from "./bot-home";
import { librarySkillPath, type ImportedSkill } from "./library";

const FORMAT = "paseo-bots";
/** Files exported before the plugin was renamed. */
const FORMATS = z.enum([FORMAT, "paseo-bot"]);
const MAX_FILES = 400;

const BotFields = BotSchema.pick({
  name: true,
  title: true,
  description: true,
  avatar: true,
  soul: true,
  provider: true,
  model: true,
  modeId: true,
  thinkingOptionId: true,
  routines: true,
  playbooks: true,
});

const SharedSkillSchema = z.object({ id: z.string(), description: z.string().default(""), source: z.string().default("") });

/** v2: skills and MCP servers travel next to the bot and join the importer's library. */
const ExportV2Schema = z.object({
  format: FORMATS,
  version: z.literal(2),
  bot: BotFields,
  skills: z.array(SharedSkillSchema).default([]),
  mcpServers: z.array(BotMcpServerSchema).default([]),
  files: z.record(z.string(), z.string()),
});

/** v1 kept MCP servers and skills on the bot. */
const ExportV1Schema = z.object({
  format: FORMATS,
  version: z.literal(1),
  bot: BotFields.extend({
    mcpServers: z.array(BotMcpServerSchema).default([]),
    skills: z.array(z.object({ name: z.string(), description: z.string().default(""), source: z.string().default(""), enabled: z.boolean().default(true) })).default([]),
  }),
  files: z.record(z.string(), z.string()),
});

/** Env values and headers can hold keys; exports keep the names and drop the values. */
function redact(servers: BotMcpServer[]): BotMcpServer[] {
  const blank = (record: Record<string, string>) => Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]));
  return servers.map((server) => ({
    ...server,
    config: server.config.type === "stdio" ? { ...server.config, env: blank(server.config.env) } : { ...server.config, headers: blank(server.config.headers) },
  }));
}

async function collect(root: string, include: (path: string) => boolean): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (Object.keys(files).length >= MAX_FILES) return;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else {
        const key = relative(root, path).split(sep).join("/");
        if (include(key)) files[key] = await readFile(path, "utf8");
      }
    }
  };
  await walk(root);
  return files;
}

export async function exportBot({ bot, includeMemory }: { bot: Bot; includeMemory: boolean }, library: Library) {
  const skills = botSkills(bot, library);
  const files: Record<string, string> = {};
  for (const skill of skills) {
    const skillFiles = await collect(librarySkillPath(skill.id), () => true);
    for (const [path, text] of Object.entries(skillFiles)) files[`skills/${skill.id}/${path}`] = text;
  }
  if (includeMemory) Object.assign(files, await collect(botDataPath(bot.id), (path) => path === "MEMORY.md" || path.startsWith("memory/")));
  const payload: z.input<typeof ExportV2Schema> = {
    format: FORMAT,
    version: 2,
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      avatar: bot.avatar,
      soul: bot.soul,
      provider: bot.provider,
      model: bot.model,
      modeId: bot.modeId,
      thinkingOptionId: bot.thinkingOptionId,
      // Routines arrive paused, as in OpenMausBot's team files.
      // Results chats only exist on this host.
      routines: bot.routines.map((routine) => ({ ...routine, enabled: false, resultsChatId: null })),
      playbooks: bot.playbooks,
    },
    skills: skills.map((skill) => ({ id: skill.id, description: skill.description, source: skill.source })),
    mcpServers: redact(botMcpServers(bot, library).map((server) => ({ name: server.name, enabled: true, config: server.config }))),
    files,
  };
  return { json: JSON.stringify(payload, null, 2) };
}

function parseExport(json: string): z.infer<typeof ExportV2Schema> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("That isn't a paseo-bots export.");
  }
  const v2 = ExportV2Schema.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = ExportV1Schema.safeParse(raw);
  if (!v1.success) throw new Error("That isn't a paseo-bots export.");
  const { mcpServers, skills, ...bot } = v1.data.bot;
  return {
    format: FORMAT,
    version: 2,
    bot,
    skills: skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.name, description: skill.description, source: skill.source })),
    mcpServers: mcpServers.filter((server) => server.enabled),
    files: v1.data.files,
  };
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/**
 * Writes an exported bot's memory for `botId` and its skills into the library
 * (a skill already in the library is kept as is). Returns the bot fields to
 * save and the skills and MCP servers to add to the library.
 */
export async function importBot({ botId, json }: { botId: string; json: string }): Promise<{ bot: Bot; skills: ImportedSkill[]; mcpServers: BotMcpServer[] }> {
  const parsed = parseExport(json);
  const skills = parsed.skills.map((skill) => ({ ...skill, id: sanitizeSkillName(skill.id) }));
  const fresh = new Set<string>();
  for (const skill of skills) if (!(await exists(librarySkillPath(skill.id)))) fresh.add(skill.id);

  const root = botDataPath(botId);
  for (const [path, text] of Object.entries(parsed.files)) {
    if (path.includes("..")) continue;
    let target: string | null = null;
    if (path === "MEMORY.md" || path.startsWith("memory/")) target = join(root, ...path.split("/"));
    else if (path.startsWith("skills/")) {
      const [, id, ...rest] = path.split("/");
      const clean = id ? sanitizeSkillName(id) : "";
      if (fresh.has(clean) && rest.length > 0) target = join(librarySkillPath(clean), ...rest);
    }
    if (!target) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  const now = new Date().toISOString();
  const bot: Bot = {
    ...parsed.bot,
    id: botId,
    hostId: null,
    cwd: null,
    alwaysAllow: [],
    skillIds: skills.map((skill) => skill.id),
    mcpServerIds: [],
    apps: [],
    // Contact with other bots starts at asking, as on a new bot.
    contactBots: "ask",
    routines: parsed.bot.routines.map((routine) => ({ ...routine, id: newRoutineId(), enabled: false, resultsChatId: null, createdAt: now })),
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  return { bot, skills, mcpServers: parsed.mcpServers };
}
