import type { Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { newUuid } from "../shared/uuid";
import { ensureBotHome } from "./bot-home";
import type { BotsHost } from "./host";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

/**
 * Starts a chat for a bot on this host, the way the app does: its system
 * prompt, its folder, and the plugin's tools and connected apps. Routines and
 * requests from other bots start chats with it.
 */
export async function startChat(host: BotsHost, relay: Relay, bot: Bot, input: { prompt: string; title: string; labels: Record<string, string> }): Promise<string> {
  const paseo = host.requirePaseo();
  if (bot.hostId) throw new Error(`${bot.name} runs on another host, so its chats can't be started from here.`);
  const library = await host.library();
  const home = await ensureBotHome({ botId: bot.id });
  const { systemPrompt: system } = await systemPrompt({ bot, local: true }, library, paseo);
  const agentId = newUuid();
  return startBotChat(paseo, {
    bot,
    library,
    agentId,
    plugin: { tools: await relay.mountTools(bot.id, agentId), apps: bot.apps.length ? await relay.mountApps(bot.id) : null },
    placement: bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root },
    prompt: input.prompt,
    systemPrompt: system,
    title: input.title,
    labels: input.labels,
  });
}
