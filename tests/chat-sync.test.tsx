import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat, type ChatState } from "../client/useChat";
import type { PaseoApi } from "../client/paseo";

const restoreCards = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => restoreCards }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (seq: number, type = "tool_call", text = `item ${seq}`) => ({
  provider: "claude", seqStart: seq, seqEnd: seq, timestamp: "2026-11-15T12:00:00Z", item: { type, text },
});

let root: ReactTestRenderer | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.useRealTimers(); restoreCards.mockReset(); });

async function mount(initial: ReturnType<typeof entry>[]) {
  let entries = initial;
  let epoch = "first";
  let listener: (event: unknown) => void = () => {};
  let state!: ChatState;
  let failBefore = false;
  let pauseBefore: Promise<void> | null = null;
  let beforeFlags: { gap?: boolean; epoch?: string } | null = null;
  let afterFlag: "reset" | "staleCursor" | "gap" | null = null;
  const handle = {
    current: () => null,
    subscribe: () => () => {},
    refresh: async () => null,
    timeline: {
      subscribe: (next: typeof listener) => { listener = next; return () => {}; },
      refetch: vi.fn(async (options: { direction: string; cursor?: { epoch: string; seq: number }; limit: number }) => {
        if (failBefore && options.direction === "before") throw new Error("history temporarily unavailable");
        if (options.direction === "before" && pauseBefore) await pauseBefore;
        if (options.direction === "before" && beforeFlags) {
          const flags = beforeFlags;
          beforeFlags = null;
          return { entries: [entry(1, "assistant_message", "invalid older page")], epoch: flags.epoch ?? epoch, startCursor: { epoch: flags.epoch ?? epoch, seq: 1 }, endCursor: { epoch: flags.epoch ?? epoch, seq: 1 }, hasOlder: false, hasNewer: false, reset: false, staleCursor: false, gap: flags.gap ?? false, error: null, agent: null };
        }
        const flag = options.direction === "after" ? afterFlag : null;
        afterFlag = null;
        const stale = !!flag || (options.cursor && options.cursor.epoch !== epoch);
        const eligible = options.direction === "tail" || stale ? entries : entries.filter(e => options.direction === "before" ? e.seqStart < options.cursor!.seq : e.seqEnd > options.cursor!.seq);
        const selected = options.direction === "after" && !stale ? eligible.slice(0, options.limit) : eligible.slice(-options.limit);
        const cursor = (e: ReturnType<typeof entry> | undefined) => e ? { epoch, seq: e.seqStart } : null;
        return { entries: selected, epoch, startCursor: cursor(selected[0]), endCursor: cursor(selected.at(-1)), hasOlder: !!selected[0] && selected[0].seqStart > entries[0]!.seqStart, hasNewer: !!selected.at(-1) && selected.at(-1)!.seqEnd < entries.at(-1)!.seqEnd, reset: flag === "reset" || (!flag && !!stale), staleCursor: flag === "staleCursor" || (!flag && !!stale), gap: flag === "gap", error: null, agent: null };
      }),
    },
  };
  const api = { agents: { ref: () => handle } } as unknown as PaseoApi;
  function Harness() { state = useChat(api, "chat"); return null; }
  await act(async () => { root = create(<Harness />); });
  return {
    state: () => state,
    replace: async (next = entries, nextEpoch = epoch) => { entries = next; epoch = nextEpoch; await act(async () => listener({ event: { type: "replacement" } })); },
    older: async () => { await act(async () => state.loadOlder()); },
    fail: () => { failBefore = true; },
    requests: handle.timeline.refetch,
    pauseOlder: () => {
      let release!: () => void;
      pauseBefore = new Promise<void>((resolve) => { release = resolve; });
      return async () => { await act(async () => { pauseBefore = null; release(); }); };
    },
    invalidOlder: (flags: NonNullable<typeof beforeFlags>) => { beforeFlags = flags; },
    resetAfter: async (flag: NonNullable<typeof afterFlag>) => {
      afterFlag = flag;
      await act(async () => { listener({ event: { type: "append" } }); await vi.advanceTimersByTimeAsync(80); });
    },
  };
}

describe("chat history synchronization", () => {
  it("keeps loaded prompts and answers when a replacement refreshes the tail", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, i % 20 === 0 ? "user_message" : "assistant_message"));
    const chat = await mount(entries);
    await chat.older();
    expect(chat.state().entries[0]!.seqStart).toBe(1);
    await chat.replace([...entries, entry(61, "assistant_message", "new answer")]);
    expect(chat.state().entries[0]!.seqStart).toBe(1);
    expect(chat.state().entries.at(-1)!.item).toMatchObject({ text: "new answer" });
  });

  it("loads the prompt when a long tool-heavy turn fills the tail page", async () => {
    const entries = [entry(1, "user_message", "my prompt"), entry(2, "assistant_message", "my answer"), ...Array.from({ length: 85 }, (_, i) => entry(i + 3))];
    const chat = await mount(entries);
    expect(chat.state().entries[0]!.item).toMatchObject({ text: "my prompt" });
    expect(chat.state().entries[1]!.item).toMatchObject({ text: "my answer" });
  });

  it("stops at the relevant prompt instead of loading the whole older transcript", async () => {
    const entries = [...Array.from({ length: 80 }, (_, i) => entry(i + 1, i === 0 ? "user_message" : "tool_call")), entry(81, "user_message", "recent prompt"), ...Array.from({ length: 65 }, (_, i) => entry(i + 82))];
    const chat = await mount(entries);
    expect(chat.state().entries[0]!.seqStart).toBe(81);
    expect(chat.state().hasOlder).toBe(true);
  });

  it("keeps displayed history if rebuilding the visible window fails", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, "user_message"));
    const chat = await mount(entries);
    await chat.older();
    chat.fail();
    await chat.replace([...entries, entry(61)]);
    expect(chat.state().entries[0]!.seqStart).toBe(1);
    expect(chat.state().error).toContain("history temporarily unavailable");
  });

  it("rebuilds a new epoch without mixing old text into reused sequence numbers", async () => {
    const chat = await mount([entry(1, "user_message", "old prompt"), entry(2, "assistant_message", "old answer")]);
    await chat.replace([entry(1, "user_message", "new prompt"), ...Array.from({ length: 50 }, (_, i) => entry(i + 2))], "second");
    expect(chat.state().entries[0]!.item).toMatchObject({ text: "new prompt" });
    expect(JSON.stringify(chat.state().entries)).not.toContain("old answer");
  });

  it.each(["reset", "staleCursor", "gap"] as const)("keeps the loaded window when an incremental page reports %s", async (flag) => {
    vi.useFakeTimers();
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, "user_message"));
    const chat = await mount(entries);
    await chat.older();
    await chat.resetAfter(flag);
    expect(chat.state().entries.map((entry) => entry.seqStart)).toEqual(entries.map((entry) => entry.seqStart));
  });

  it("queues a replacement behind an older read instead of racing their cursors", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, "user_message"));
    const chat = await mount(entries);
    const release = chat.pauseOlder();
    await chat.older();
    await chat.replace([...entries, entry(61, "assistant_message", "new answer")]);
    expect(chat.requests.mock.calls.filter(([request]) => request.direction === "tail")).toHaveLength(1);
    expect(chat.state().loadingOlder).toBe(true);
    await release();
    expect(chat.requests.mock.calls.filter(([request]) => request.direction === "tail")).toHaveLength(2);
    expect(chat.state().entries[0]!.seqStart).toBe(1);
    expect(chat.state().entries.at(-1)!.item).toMatchObject({ text: "new answer" });
    expect(chat.state().loadingOlder).toBe(false);
  });

  it.each([{ gap: true }, { epoch: "another" }])("rebuilds rather than mixing an invalid older page: %j", async (flags) => {
    const chat = await mount(Array.from({ length: 60 }, (_, i) => entry(i + 1, "user_message")));
    chat.invalidOlder(flags);
    await chat.older();
    expect(JSON.stringify(chat.state().entries)).not.toContain("invalid older page");
    expect(chat.requests.mock.calls.filter(([request]) => request.direction === "tail")).toHaveLength(2);
    expect(chat.state().loadingOlder).toBe(false);
  });

  it("preserves card recovery and keeps the recovered history visible if card restoration fails", async () => {
    restoreCards.mockRejectedValueOnce(new Error("cards unavailable"));
    const chat = await mount([entry(1, "user_message", "keep this prompt")]);
    expect(restoreCards).toHaveBeenCalledWith({ agentId: "chat" });
    expect(chat.state().entries[0]!.item).toMatchObject({ text: "keep this prompt" });
    expect(chat.state().error).toBe("Could not restore saved cards: cards unavailable");
  });

  it("clears old cursors when a replacement empties the timeline", async () => {
    vi.useFakeTimers();
    const chat = await mount([entry(1, "user_message")]);
    await chat.replace([], "second");
    expect(chat.state().entries).toEqual([]);
    await chat.resetAfter("gap");
    expect(chat.requests.mock.calls.at(-1)?.[0]).toMatchObject({ direction: "tail" });
  });
});
