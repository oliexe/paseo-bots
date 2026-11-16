import { z } from "zod";

export const MAX_MESSAGE_BOOKMARKS = 500;
export const MessageBookmarkSchema = z.object({
  botId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256),
  rowKey: z.string().max(32).regex(/^e\d+$/),
  role: z.enum(["user", "assistant"]),
  chatTitle: z.string().max(200),
  messageAt: z.number().finite().nonnegative().max(8.64e15),
  createdAt: z.string().datetime(),
});
export type MessageBookmark = z.infer<typeof MessageBookmarkSchema>;

export function bookmarkKey(bookmark: Pick<MessageBookmark, "hostId" | "botId" | "chatId" | "rowKey">): string {
  return JSON.stringify([bookmark.hostId, bookmark.botId, bookmark.chatId, bookmark.rowKey]);
}

/** A replaced timeline must not send a bookmark to a different message reusing its sequence. */
export function bookmarkMatchesRow(bookmark: Pick<MessageBookmark, "rowKey" | "role" | "messageAt">, row: { key: string; kind: string; timestamp: number }): boolean {
  return bookmark.rowKey === row.key && bookmark.role === row.kind && bookmark.messageAt === row.timestamp;
}

/** Persist references only; the original message remains in Paseo's timeline. */
export function setMessageBookmark(current: readonly MessageBookmark[], bookmark: MessageBookmark, saved: boolean): MessageBookmark[] {
  const key = bookmarkKey(bookmark);
  const existing = current.some((entry) => bookmarkKey(entry) === key);
  if (!saved) return current.filter((entry) => bookmarkKey(entry) !== key);
  if (existing) return [...current];
  if (current.length >= MAX_MESSAGE_BOOKMARKS) throw new Error(`You have ${MAX_MESSAGE_BOOKMARKS} saved messages. Remove a bookmark before saving another.`);
  return [MessageBookmarkSchema.parse(bookmark), ...current];
}

/** Quotes are appended to a draft, never submitted or silently shortened. */
export function quoteMessage(text: string, role: "user" | "assistant"): string {
  if (!text.trim()) return "";
  if (text.length > 64_000) throw new Error("This message is too long to quote in full. Copy the relevant passage into your reply.");
  return `> ${role === "user" ? "You wrote" : "Bot replied"}:\n${text.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}
