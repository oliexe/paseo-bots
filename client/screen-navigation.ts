import type { PluginOpenScreenInput, PluginScreenLocation, PluginScreenParams } from "@getpaseo/plugin/client";
import type { LibraryTarget } from "./navigation";
import { newUuid } from "../shared/uuid";

export type BotScreen = "bots" | "bot-chat" | "bot-settings" | "bot-section" | "bot-library" | "bot-library-item" | "bot-teams";

export const BOT_SCREENS: { id: BotScreen; title: string }[] = [
  { id: "bots", title: "Bots" },
  { id: "bot-chat", title: "Chat" },
  { id: "bot-settings", title: "Bot settings" },
  { id: "bot-section", title: "Bot settings" },
  { id: "bot-library", title: "Skills & Tools" },
  { id: "bot-library-item", title: "Skills & Tools" },
  { id: "bot-teams", title: "Team map" },
];

/** Layout changes rebuild selection objects but must not invalidate the same in-flight draft. */
export function chatSelectionKey(hostId: string, selection: { botId: string; chatId: string | null } | null, draftId?: string): string {
  return JSON.stringify([hostId, selection?.botId ?? null, selection?.chatId ?? null, draftId ?? null]);
}

/** Persist chat selection at every width; a desktop settings panel can travel with it. */
export function chatScreen(selection: { botId: string; chatId: string | null; prompt?: string; title?: string }, title: string, panel?: { open: boolean; section: string | null }): PluginOpenScreenInput {
  return {
    screenId: "bot-chat",
    params: {
      botId: selection.botId,
      title,
      ...(selection.chatId ? { chatId: selection.chatId } : { draftId: newUuid() }),
      ...(selection.prompt ? { prompt: selection.prompt, chatTitle: selection.title ?? "" } : {}),
      ...(panel?.open ? { panel: "open", ...(panel.section ? { section: panel.section } : {}) } : {}),
    },
  };
}

/** A bot shortcut resumes work; only the explicit New chat action starts over. */
export function pinnedBotScreen(bot: { id: string; name: string }, current: PluginScreenLocation | null, chats: readonly { id: string; updatedAt: string; archivedAt?: string | null }[]): PluginOpenScreenInput | null {
  if (current?.screenId === "bot-chat" && current.params.botId === bot.id) return null;
  const latest = chats.filter((chat) => !chat.archivedAt).reduce<(typeof chats)[number] | null>((latest, chat) => !latest || (Date.parse(chat.updatedAt) || 0) > (Date.parse(latest.updatedAt) || 0) ? chat : latest, null);
  return { screenId: "bot-chat", params: { botId: bot.id, title: bot.name, ...(latest ? { chatId: latest.id } : { draftId: newUuid() }) } };
}

// Team map is a temporary view, not a landing page. A restored route from an
// earlier app/plugin session should open the bot list without needing history.
const navigationSession = newUuid();
export function teamMapScreen(): PluginOpenScreenInput {
  return { screenId: "bot-teams", params: { navigationSession } };
}

export function resolveBotScreen(screen: BotScreen, params: PluginScreenParams): BotScreen {
  return screen === "bot-teams" && params.navigationSession !== navigationSession ? "bots" : screen;
}

export function parentScreen(screen: BotScreen, params: PluginScreenParams): { label: string; target: PluginOpenScreenInput } | null {
  if (screen === "bots") return null;
  if (screen === "bot-section" && params.botId) {
    return { label: "Bot settings", target: { screenId: "bot-settings", params: { botId: params.botId, title: "Bot settings" } } };
  }
  if (screen === "bot-library-item") return { label: "Skills & Tools", target: { screenId: "bot-library" } };
  return { label: "Bots", target: { screenId: "bots" } };
}

export function libraryScreen(target: LibraryTarget | null, title?: string): PluginOpenScreenInput {
  if (!target) return { screenId: "bot-library" };
  return {
    screenId: "bot-library-item",
    params: { kind: target.kind, ...("id" in target ? { itemId: target.id } : {}), title: title || (target.kind === "apps" ? "Connected apps" : "id" in target ? target.id : "Skills & Tools") },
  };
}

export function libraryTarget(params: PluginScreenParams): LibraryTarget | null {
  if (params.kind === "apps") return { kind: "apps" };
  if (["skill", "mcp", "app"].includes(params.kind) && params.itemId) return { kind: params.kind as "skill" | "mcp" | "app", id: params.itemId };
  return null;
}

// A newly composed chat gets its daemon ID after this route was pushed. Keep
// that ID if Paseo remounts the draft route when navigating back from settings.
const startedChats = new Map<string, string>();
// A responsive layout can remount a setup chat before its creation completes.
// The route owns that automatic prompt, not the mounted component instance.
const automaticChats = new Set<string>();
export function claimAutomaticChat(selectionKey: string): boolean {
  if (automaticChats.has(selectionKey)) return false;
  automaticChats.add(selectionKey);
  return true;
}
export function retryAutomaticChat(selectionKey: string): void {
  automaticChats.delete(selectionKey);
}
export function startedChat(hostId: string, draftId: string | undefined): string | null {
  return draftId ? startedChats.get(`${hostId}:${draftId}`) ?? null : null;
}
export function rememberStartedChat(hostId: string, draftId: string | undefined, chatId: string): void {
  if (!draftId) return;
  startedChats.set(`${hostId}:${draftId}`, chatId);
  if (startedChats.size > 100) startedChats.delete(startedChats.keys().next().value!);
}
