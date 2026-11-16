import { bookmarkKey, type MessageBookmark } from "../../shared/bookmarks";

const pending = new Map<string, MessageBookmark>();
const scope = (hostId: string, botId: string, chatId: string) => bookmarkKey({ hostId, botId, chatId, rowKey: "" });

/** Carries one jump through the normal chat navigation/remount without changing routes. */
export function requestBookmarkReveal(bookmark: MessageBookmark): void {
  pending.set(scope(bookmark.hostId, bookmark.botId, bookmark.chatId), bookmark);
  if (pending.size > 20) pending.delete(pending.keys().next().value!);
}

export function takeBookmarkReveal(hostId: string, botId: string, chatId: string | null): MessageBookmark | null {
  if (!chatId) return null;
  const key = scope(hostId, botId, chatId);
  const row = pending.get(key) ?? null;
  pending.delete(key);
  return row;
}

export function pendingBookmarkReveal(hostId: string, botId: string, chatId: string | null): MessageBookmark | null {
  return chatId ? pending.get(scope(hostId, botId, chatId)) ?? null : null;
}
