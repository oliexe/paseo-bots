import { afterEach, describe, expect, it, vi } from "vitest";
import { searchChats } from "../server/tools/chats";
import { fakeHost, makeBot } from "./helpers";

vi.mock("../server/memory", () => ({ memoryTexts: async () => [] }));
afterEach(() => { vi.useRealTimers(); });
const at = "2026-11-16T10:00:00.000Z";
const entry = (text: string, seq: number) => ({ item: { type: "assistant_message", text }, timestamp: at, seqStart: seq, seqEnd: seq });
const chat = (id: string) => ({ agent: { id, title: id, updatedAt: at } });
const cursorOf = (result: string) => /only cursor: "([a-f0-9]{48})"/.exec(result)?.[1];
function setup(list: (options: any) => Promise<any>, timeline: (id: string, options: any) => Promise<any>) {
  const bot = makeBot({ id: "search-bot" });
  const host = fakeHost([bot]);
  host.attach({ agents: { list, ref: (id: string) => ({ timeline: { refetch: (options: unknown) => timeline(id, options) } }) } } as never);
  return { bot, agentId: "search-caller", host, relay: null as never };
}

describe("paginated chat search", () => {
  it("continues past 40 chats instead of claiming that an unsearched match does not exist", async () => {
    const listed: any[] = [];
    const caller = setup(async (options) => {
      listed.push(options);
      return options.page.cursor ? { entries: [chat("older-match")], pageInfo: { hasMore: false, nextCursor: null } } : { entries: Array.from({ length: 40 }, (_, i) => chat(`c${i}`)), pageInfo: { hasMore: true, nextCursor: "older" } };
    }, async (id) => ({ entries: [entry(id === "older-match" ? "historic invoice" : "unrelated", 1)], hasOlder: false }));
    let result = await searchChats.run({ query: "invoice" }, caller);
    expect(result).toContain("More history remains");
    let pages = 1;
    while (cursorOf(result)) {
      result = await searchChats.run({ cursor: cursorOf(result) }, caller);
      if (++pages > 5) throw new Error("Search did not finish");
    }
    expect(result).toContain("historic [invoice]");
    expect(pages).toBeGreaterThan(1);
    expect(listed).toHaveLength(2);
    expect(listed[1].page.cursor).toBe("older");
    expect(listed[1].filter.labels).toEqual({ "paseo-bots.bot": "search-bot" });
  });

  it("reads older timeline pages and preserves extra matches across result pages", async () => {
    const seen: any[] = [];
    const caller = setup(async () => ({ entries: [chat("history")], pageInfo: { hasMore: false } }), async (_id, options) => {
      seen.push(options);
      if (options.direction === "tail") return { entries: [entry("invoice one", 4), entry("invoice two", 5), entry("invoice three", 6)], hasOlder: true, startCursor: { epoch: "a", seq: 4 } };
      return { entries: [entry("invoice old", 1)], hasOlder: false };
    });
    const first = await searchChats.run({ query: "invoice", limit: 2 }, caller);
    expect(first).toContain("[invoice] three");
    expect(first).toContain("[invoice] two");
    expect(first).not.toContain("[invoice] one");
    const cursor = cursorOf(first)!;
    const second = await searchChats.run({ cursor }, caller);
    expect(second).toContain("[invoice] one");
    expect(second).toContain("[invoice] old");
    expect(second).not.toContain("More history remains");
    expect(seen[1]).toMatchObject({ direction: "before", cursor: { epoch: "a", seq: 4 } });
    expect(await searchChats.run({ cursor }, caller)).toBe(second);
    expect(seen).toHaveLength(2);
    await expect(searchChats.run({ cursor }, { ...caller, agentId: "other" })).rejects.toThrow("another chat");
    await expect(searchChats.run({ cursor }, { ...caller, bot: makeBot({ id: "other-bot" }) })).rejects.toThrow("another chat");
  });

  it("reports skipped unreadable chats and refuses nonadvancing cursors", async () => {
    const caller = setup(async () => ({ entries: [chat("missing"), chat("good")], pageInfo: { hasMore: false } }), async (id) => {
      if (id === "missing") throw new Error("Disconnected");
      return { entries: [entry("invoice", 1)], hasOlder: false };
    });
    const result = await searchChats.run({ query: "invoice" }, caller);
    expect(result).toContain("Incomplete coverage");
    expect(result).toContain("missing could not be read");
    expect(result).toContain("[invoice]");
    const broken = setup(async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } }), async () => ({}));
    await expect(searchChats.run({ query: "invoice" }, broken)).rejects.toThrow("could not advance");
  });

  it("refuses multi-step directory and timeline cursor cycles", async () => {
    const directory = setup(async (options) => ({ entries: [], pageInfo: { hasMore: true, nextCursor: options.page.cursor === "a" ? "b" : "a" } }), async () => ({}));
    await expect(searchChats.run({ query: "invoice" }, directory)).rejects.toThrow("could not advance the chat search");
    const timeline = setup(async () => ({ entries: [chat("history")] }), async (_id, options) => ({ entries: [entry("unrelated", 1)], hasOlder: true, startCursor: { epoch: "a", seq: options.cursor?.seq === 1 ? 2 : 1 } }));
    await expect(searchChats.run({ query: "invoice" }, timeline)).rejects.toThrow("could not advance through");
  });

  it("does not repeat chats moved between directory pages and rejects changed continuation options", async () => {
    const timeline = vi.fn(async () => ({ entries: [entry("invoice", 1)], hasOlder: false }));
    const caller = setup(async (options) => options.page.cursor ? { entries: [chat("history"), chat("other")] } : { entries: [chat("history")], pageInfo: { hasMore: true, nextCursor: "next" } }, timeline);
    const first = await searchChats.run({ query: "invoice", limit: 1 }, caller);
    const cursor = cursorOf(first)!;
    await expect(searchChats.run({ cursor, limit: 2 }, caller)).rejects.toThrow("only cursor");
    const second = await searchChats.run({ cursor }, caller);
    expect(second).toContain('chat "other"');
    expect(second).not.toContain('chat "history"');
    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it("excludes the current chat, tool text and messages before the time range", async () => {
    const ids: string[] = [];
    const caller = setup(async () => ({ entries: [chat("search-caller"), chat("history")] }), async (id) => {
      ids.push(id);
      return { entries: [{ ...entry("invoice old", 1), timestamp: "2026-01-01T00:00:00.000Z" }, { ...entry("invoice tool", 2), item: { type: "tool_call", text: "invoice tool" } }, entry("invoice new", 3)], hasOlder: false };
    });
    const result = await searchChats.run({ query: "invoice", since: "2026-11-01" }, caller);
    expect(ids).toEqual(["history"]);
    expect(result).toContain("[invoice] new");
    expect(result).not.toContain("invoice old");
    expect(result).not.toContain("invoice tool");
  });

  it("rejects expired cursors and stale timeline projections explicitly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const caller = setup(async () => ({ entries: [chat("history")] }), async (_id, options) => options.direction === "tail" ? { entries: [entry("invoice one", 1), entry("invoice two", 2)], hasOlder: true, startCursor: { epoch: "a", seq: 1 } } : { entries: [], staleCursor: true });
    const first = await searchChats.run({ query: "invoice", limit: 2 }, caller);
    const cursor = cursorOf(first)!;
    await expect(searchChats.run({ cursor }, caller)).rejects.toThrow("chat changed");
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect(searchChats.run({ cursor }, caller)).rejects.toThrow("expired");
  });
});
