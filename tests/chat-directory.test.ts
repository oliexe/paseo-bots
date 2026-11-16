import { describe, expect, it, vi } from "vitest";
import { listBotChats } from "../client/chat-directory";

const agent = (id: string, updatedAt: string, archivedAt: string | null = null) => ({ agent: { id, updatedAt, archivedAt } });
describe("bot chat directory", () => {
  it("loads all pages, deduplicates live updates and excludes archived chats", async () => {
    const list = vi.fn().mockResolvedValueOnce({ entries: [agent("first", "2026-11-16"), agent("archived", "2026-11-15", "2026-11-16")], pageInfo: { hasMore: true, nextCursor: "next" } })
      .mockResolvedValueOnce({ entries: [agent("first", "2026-11-17"), agent("old", "2026-01-01")], pageInfo: { hasMore: false, nextCursor: null } });
    const abort = new AbortController();
    const result = await listBotChats({ agents: { list } } as never, "bot-x", abort.signal);
    expect(result.map((item) => item.id)).toEqual(["first", "old"]);
    expect(result[0]?.updatedAt).toBe("2026-11-17");
    expect(list.mock.calls[1]?.[0]).toMatchObject({ page: { cursor: "next" }, filter: { labels: { "paseo-bots.bot": "bot-x" }, includeBackground: true }, signal: abort.signal });
  });
  it("does not silently truncate on a broken pagination response", async () => {
    const list = vi.fn().mockResolvedValue({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } });
    await expect(listBotChats({ agents: { list } } as never, "bot-x")).rejects.toThrow("next page");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("keeps the newest duplicate and honors an archive observed on a later page", async () => {
    const list = vi.fn().mockResolvedValueOnce({ entries: [agent("live", "2026-11-16"), agent("removed", "2026-11-15")], pageInfo: { hasMore: true, nextCursor: "next" } })
      .mockResolvedValueOnce({ entries: [agent("live", "2026-11-01"), agent("removed", "2026-11-17", "2026-11-17")], pageInfo: { hasMore: false } });
    const result = await listBotChats({ agents: { list } } as never, "bot-x");
    expect(result.map((item) => item.id)).toEqual(["live"]);
    expect(result[0]?.updatedAt).toBe("2026-11-16");
  });
  it("stops before requesting more pages after cancellation", async () => {
    const abort = new AbortController();
    const list = vi.fn().mockImplementation(async () => {
      abort.abort();
      return { entries: [], pageInfo: { hasMore: true, nextCursor: "next" } };
    });
    await expect(listBotChats({ agents: { list } } as never, "bot-x", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
