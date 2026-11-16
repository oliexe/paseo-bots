import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BOOKMARKS, MessageBookmarkSchema, bookmarkKey, bookmarkMatchesRow, quoteMessage, setMessageBookmark, type MessageBookmark } from "../shared/bookmarks";
import { botSettings } from "../shared/bot";
import { appendDraftText } from "../client/chat/composer/logic";
import { pendingBookmarkReveal, requestBookmarkReveal, takeBookmarkReveal } from "../client/chat/bookmark-reveal";

const bookmark = (rowKey = "e12"): MessageBookmark => ({ botId: "bot-1", hostId: "host-1", chatId: "chat-1", rowKey, role: "assistant", chatTitle: "Weekly review", messageAt: 1_794_830_400_000, createdAt: "2026-11-16T12:00:00.000Z" });

describe("saved messages", () => {
  it("stores host-scoped references without copying message text or raw tool content", () => {
    const parsed = MessageBookmarkSchema.parse({ ...bookmark(), text: "private message", toolResult: "secret" });
    expect(parsed).not.toHaveProperty("text");
    expect(parsed).not.toHaveProperty("toolResult");
    const values = botSettings.schema.parse({ bookmarks: [parsed] });
    expect(values.bookmarks).toEqual([bookmark()]);
    expect(botSettings.schema.parse({}).bookmarks).toBeUndefined();
    expect(bookmarkKey(bookmark())).not.toBe(bookmarkKey({ ...bookmark(), hostId: "other-host" }));
  });

  it("deduplicates repeated saves and removes only the requested message", () => {
    const saved = setMessageBookmark([], bookmark(), true);
    expect(setMessageBookmark(saved, bookmark(), true)).toEqual(saved);
    const next = setMessageBookmark(saved, bookmark("e13"), true);
    expect(setMessageBookmark(next, bookmark(), false)).toEqual([bookmark("e13")]);
    expect(saved).toEqual([bookmark()]);
  });

  it("refuses a full bookmark store without silently dropping older references", () => {
    const full = Array.from({ length: MAX_MESSAGE_BOOKMARKS }, (_, index) => bookmark(`e${index}`));
    expect(() => setMessageBookmark(full, bookmark("e9999"), true)).toThrow(/Remove a bookmark/);
    expect(full).toHaveLength(MAX_MESSAGE_BOOKMARKS);
    expect(setMessageBookmark(full, full[0]!, true)).toHaveLength(MAX_MESSAGE_BOOKMARKS);
    expect(setMessageBookmark(full, full[0]!, false)).toHaveLength(MAX_MESSAGE_BOOKMARKS - 1);
    expect(botSettings.schema.safeParse({ bookmarks: [...full, bookmark("e9999")] }).success).toBe(false);
  });

  it("carries cross-chat jumps once and scopes them to the exact bot and host", () => {
    requestBookmarkReveal(bookmark());
    expect(pendingBookmarkReveal("host-1", "bot-1", "chat-1")).toEqual(bookmark());
    expect(pendingBookmarkReveal("host-1", "bot-1", "chat-1")).toEqual(bookmark());
    expect(takeBookmarkReveal("other", "bot-1", "chat-1")).toBeNull();
    expect(takeBookmarkReveal("host-1", "other", "chat-1")).toBeNull();
    expect(takeBookmarkReveal("host-1", "bot-1", "chat-1")).toEqual(bookmark());
    expect(takeBookmarkReveal("host-1", "bot-1", "chat-1")).toBeNull();
  });

  it("does not reveal an unrelated message after a timeline replacement reuses a sequence", () => {
    const original = { key: "e12", kind: "assistant", timestamp: bookmark().messageAt };
    expect(bookmarkMatchesRow(bookmark(), original)).toBe(true);
    expect(bookmarkMatchesRow(bookmark(), { ...original, timestamp: original.timestamp + 1 })).toBe(false);
    expect(bookmarkMatchesRow(bookmark(), { ...original, kind: "user" })).toBe(false);
    expect(bookmarkMatchesRow(bookmark(), { ...original, key: "e13" })).toBe(false);
  });
});

describe("quote in reply", () => {
  it("quotes every line and appends to an existing unsent draft", () => {
    const quote = quoteMessage("First line\r\n\r\n> Nested quote", "assistant");
    expect(quote).toBe("> Bot replied:\n> First line\n> \n> > Nested quote\n\n");
    expect(appendDraftText("Keep my unsent reply", quote)).toBe(`Keep my unsent reply\n\n${quote}`);
    expect(quoteMessage("Hello", "user")).toContain("You wrote:");
    expect(quoteMessage(" \n", "assistant")).toBe("");
  });

  it("refuses an oversized quote instead of silently truncating it", () => {
    expect(() => quoteMessage("x".repeat(64_001), "assistant")).toThrow(/too long to quote in full/);
    expect(quoteMessage("x".repeat(64_000), "assistant")).toContain("x".repeat(64_000));
  });
});
