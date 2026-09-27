import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, and the daily log gets a line saying what the bot did.

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: PluginLifecycleEvents["agent.turn_started"]): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (botId) await journal.begin(botId);
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, { agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
  const chat = await host.chatOf(agent.id);
  if (!chat) return;
  const { botId } = chat;
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  if (outcome.kind === "canceled") return;
  const { reply, tools } = lastTurn(timeline);
  const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
  if (line) await appendDailyLog(botId, line);
}
