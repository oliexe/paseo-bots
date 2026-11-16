import type { PluginHookEvents } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, and the daily log gets a line saying what the bot did.

/** How much of a chat is read back after a turn: enough for a tool-heavy one. */
const TURN_TAIL = 80;

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: { agent: Pick<PluginHookEvents["agent.turn.before"]["agent"], "id"> }): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (botId) await journal.begin(botId);
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, scheduler: Pick<RoutineScheduler, "finished">, { agent, outcome }: { agent: Pick<PluginHookEvents["agent.turn.after"]["agent"], "id" | "title">; outcome: PluginHookEvents["agent.turn.after"]["outcome"]; turnId?: string | null; timeline?: unknown }): Promise<void> {
  const chat = await host.chatOf(agent.id);
  if (!chat) return;
  const { botId } = chat;
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  const { reply, tools } = lastTurn(await latestItems(host, agent.id));
  if (chat.routineId) await scheduler.finished(chat.routineId, agent.id, outcome, reply);
  if (outcome.kind === "canceled") return;
  const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
  if (line) await appendDailyLog(botId, line);
}

/**
 * The newest items of a chat, read back from Paseo: since Paseo 0.13 the turn-ended hook's
 * own `timeline` is always empty. Empty when the chat can't be read.
 */
async function latestItems(host: BotsHost, agentId: string): Promise<{ type: string; text?: unknown; name?: unknown }[]> {
  const page = await host.paseo?.agents
    .ref(agentId)
    .timeline.refetch({ direction: "tail", projection: "projected", limit: TURN_TAIL })
    .catch(() => null);
  return (page?.entries ?? []).map((entry) => entry.item as { type: string; text?: unknown; name?: unknown });
}
