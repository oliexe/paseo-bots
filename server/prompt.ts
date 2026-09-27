import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { recentWork } from "../shared/activity";
import { selectPlaybooks } from "../shared/playbooks";
import { paseoToolsState, type PaseoToolsConfig } from "../shared/paseo-tools";
import type { AppAccount, PromptApp } from "../shared/apps";
import { accounts, catalog, readState } from "./composio";
import { botSkills, composeSystemPrompt, promptSections, type Bot, type BotGroup, type BotSettingsValues, type Library, type PromptContext } from "../shared/bot";
import { teamOf, teamPrompt } from "../shared/groups";
import { linkBotSkills, skillSha } from "./library";
import { injectedMemory, MAIN_MEMORY, memoryFolder, recentLogEntries } from "./memory";

/**
 * The connected apps a bot may use right now (allowed for it and signed in on
 * this host), with their accounts when an app has several.
 */
async function botApps(bot: Bot): Promise<PromptApp[]> {
  if (bot.apps.length === 0 || !(await readState()).apiKey) return [];
  const connected = (await accounts().catch(() => ({ accounts: [] as AppAccount[] }))).accounts.filter((account) => account.status === "connected");
  const slugs = bot.apps.filter((slug) => connected.some((account) => account.slug === slug));
  if (slugs.length === 0) return [];
  const names = new Map((await catalog().catch(() => ({ apps: [] }))).apps.map((app) => [app.slug, app.name]));
  return slugs.map((slug) => {
    const mine = connected.filter((account) => account.slug === slug);
    return { name: names.get(slug) ?? slug, accounts: mine.length > 1 ? mine.map((account) => ({ account: account.alias ?? account.id, name: account.name })) : [] };
  });
}

export interface ChatStart {
  /** The chat's first message, which picks the playbooks. */
  message?: string;
  /** The bot's team and every bot, when it's on one. */
  team?: { group: BotGroup; bots: Bot[] };
}

/**
 * Memory and skills live on this host, so only bots running here get them:
 * an agent on another host couldn't read or update the files.
 */
export async function promptContext(bot: Bot, local: boolean, library: Library, paseoTools: boolean, start: ChatStart = {}): Promise<PromptContext> {
  // Playbooks and teams live in the settings, so they travel with the bot to any host.
  const playbooks = selectPlaybooks(start.message ?? "", bot.playbooks);
  const team = start.team ? teamPrompt(start.team.group, bot, start.team.bots) : null;
  // Connected apps go through this host's relay, so bots on other hosts can't reach them.
  if (!local) return { memory: "", memoryPath: null, recentWork: [], playbooks, team, skills: [], paseoTools, botTools: false, apps: [] };
  // Only skills whose SKILL.md is still what the user reviewed.
  const skills: typeof library.skills = [];
  for (const skill of botSkills(bot, library)) {
    if (skill.reviewedSha === undefined || (skill.reviewedSha !== null && (await skillSha(skill.id)) === skill.reviewedSha)) skills.push(skill);
  }
  const paths = await linkBotSkills(
    bot.id,
    skills.map((skill) => skill.id),
  );
  return {
    memory: await injectedMemory(bot.id),
    memoryPath: join(memoryFolder(bot.id), MAIN_MEMORY),
    recentWork: recentWork(await recentLogEntries(bot.id, 3), new Date()),
    playbooks,
    team,
    skills: skills.map((skill) => ({ name: skill.id, description: skill.description, path: paths.get(skill.id)! })),
    paseoTools,
    botTools: true,
    apps: await botApps(bot),
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

/** The system prompt for a new chat; `settings` supplies the bot's team. */
export async function systemPrompt({ bot, local, message }: { bot: Bot; local: boolean; message?: string }, library: Library, paseo: PaseoApi | null, settings?: BotSettingsValues | null) {
  const group = teamOf(bot.id, settings?.groups ?? []);
  const start: ChatStart = { ...(message !== undefined ? { message } : {}), ...(group && settings ? { team: { group, bots: settings.bots } } : {}) };
  // Another host's config isn't readable from here; Paseo gives agents its tools by default.
  const context = await promptContext(bot, local, library, local ? await paseoToolsOn(paseo, bot.provider) : true, start);
  return { systemPrompt: composeSystemPrompt(bot, context), sections: promptSections(bot, context) };
}
