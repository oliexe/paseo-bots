import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { paseoToolsState, type PaseoToolsConfig } from "../shared/paseo-tools";
import { catalog, connectedSlugs, readState } from "./composio";
import { botSkills, composeSystemPrompt, promptSections, type Bot, type Library, type PromptContext } from "../shared/bot";
import { linkBotSkills } from "./library";
import { injectedMemory, MAIN_MEMORY, memoryFolder } from "./memory";

/**
 * Memory and skills live on this host, so only bots running here get them:
 * an agent on another host couldn't read or update the files.
 */
/** Names of the connected apps a bot may use right now: allowed for it and signed in on this host. */
async function botAppNames(bot: Bot): Promise<string[]> {
  if (bot.apps.length === 0 || !(await readState()).apiKey) return [];
  const connected = new Set(await connectedSlugs());
  const slugs = bot.apps.filter((slug) => connected.has(slug));
  if (slugs.length === 0) return [];
  const names = new Map((await catalog().catch(() => ({ apps: [] }))).apps.map((app) => [app.slug, app.name]));
  return slugs.map((slug) => names.get(slug) ?? slug);
}

export async function promptContext(bot: Bot, local: boolean, library: Library, paseoTools: boolean): Promise<PromptContext> {
  // Connected apps go through this host's relay, so bots on other hosts can't reach them.
  if (!local) return { memory: "", memoryPath: null, skills: [], paseoTools, apps: [] };
  const skills = botSkills(bot, library);
  const paths = await linkBotSkills(
    bot.id,
    skills.map((skill) => skill.id),
  );
  return {
    memory: await injectedMemory(bot.id),
    memoryPath: join(memoryFolder(bot.id), MAIN_MEMORY),
    skills: skills.map((skill) => ({ name: skill.id, description: skill.description, path: paths.get(skill.id)! })),
    paseoTools,
    apps: await botAppNames(bot),
  };
}

/** Whether this host gives the provider's agents Paseo's tools. Assumes yes when the config can't be read. */
export async function paseoToolsOn(paseo: PaseoApi | null, provider: string): Promise<boolean> {
  if (!paseo) return true;
  try {
    const { config } = await paseo.config.get();
    return paseoToolsState(config as PaseoToolsConfig, provider).on;
  } catch {
    return true;
  }
}

export async function systemPrompt({ bot, local }: { bot: Bot; local: boolean }, library: Library, paseo: PaseoApi | null) {
  // Another host's config isn't readable from here; Paseo gives agents its tools by default.
  const context = await promptContext(bot, local, library, local ? await paseoToolsOn(paseo, bot.provider) : true);
  return { systemPrompt: composeSystemPrompt(bot, context), sections: promptSections(bot, context) };
}
