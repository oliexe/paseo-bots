import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveKey, orderChats } from "../shared/sidebar";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
const storage = new Map<string, string>();
beforeEach(() => {
  vi.resetModules(); storage.clear();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => { vi.unstubAllGlobals(); });

const older = { id: "lower", createdAt: "2026-01-01", updatedAt: "2026-01-04", lastUserMessageAt: "2026-01-03", attentionTimestamp: "2026-01-04", status: "closed", activeTurn: null };
const newer = { ...older, id: "upper", createdAt: "2026-01-02", updatedAt: "2026-01-11", lastUserMessageAt: "2026-01-10", attentionTimestamp: "2026-01-11", status: "idle" };

describe("conversation activity dates", () => {
  it("keeps ID order through closed -> initializing -> idle with only updatedAt changed", async () => {
    const { observeChatActivity } = await import("../client/chat-activity");
    const upper = { ...newer, activityAt: observeChatActivity("host", newer) };
    const first = observeChatActivity("host", older);
    for (const status of ["initializing", "idle"]) {
      const lower = { ...older, status, updatedAt: "2026-02-01" };
      const activityAt = observeChatActivity("host", lower);
      expect(activityAt).toBe(first);
      expect(orderChats([{ ...lower, activityAt }, upper], "activity").map(x => x.id)).toEqual(["upper", "lower"]);
    }
  });

  it("retains reply activity after marking read and after client module replacement", async () => {
    const { observeChatActivity } = await import("../client/chat-activity");
    const at = observeChatActivity("host", newer);
    const read = { ...newer, attentionTimestamp: null, updatedAt: "2026-02-01" };
    expect(observeChatActivity("host", read)).toBe(at);
    vi.resetModules();
    expect((await import("../client/chat-activity")).observeChatActivity("host", read)).toBe(at);
  });

  it("ignores title and metadata updates, including during an active turn", async () => {
    const { observeChatActivity } = await import("../client/chat-activity");
    const active = { ...older, status: "running", activeTurn: { turnId: "turn", startedAt: "2026-01-12" }, lastUsage: { outputTokens: 3 } };
    const at = observeChatActivity("host", active);
    const renamed = { ...active, title: "Renamed", updatedAt: "2026-02-01" };
    expect(observeChatActivity("host", renamed)).toBe(at);
  });

  it("promotes real new messages, turn starts, output usage and turn completion", async () => {
    const { observeChatActivity } = await import("../client/chat-activity");
    const initial = observeChatActivity("host", older);
    const message = { ...older, lastUserMessageAt: "2026-01-12" };
    const messageAt = observeChatActivity("host", message); expect(messageAt > initial).toBe(true);
    const run = { ...message, status: "running", activeTurn: { turnId: "turn", startedAt: "2026-01-13" }, lastUsage: { outputTokens: 3 } };
    const started = observeChatActivity("host", run); expect(started > messageAt).toBe(true);
    const output = observeChatActivity("host", { ...run, updatedAt: "2026-01-14", lastUsage: { outputTokens: 4 } }); expect(output > started).toBe(true);
    const finished = observeChatActivity("host", { ...message, status: "idle", updatedAt: "2026-01-15" }); expect(finished > output).toBe(true);
    const upper = { ...newer, activityAt: observeChatActivity("host", newer) };
    expect(orderChats([{ ...older, activityAt: finished }, upper], "activity").map(x => x.id)).toEqual(["lower", "upper"]);
  });

  it("does not share activity dates between hosts with the same Chat ID", async () => {
    const { observeChatActivity } = await import("../client/chat-activity");
    const a = observeChatActivity("a", { ...older, attentionTimestamp: "2026-02-01" });
    const b = observeChatActivity("b", older); expect(b < a).toBe(true);
  });

  it("keeps manual ordering and drag/move semantics regardless of activity", async () => {
    const chats = [older, newer]; const stored = ["lower", "upper"];
    const updated = [{ ...older, updatedAt: "2026-02-01", activityAt: "2026-03-01" }, newer];
    expect(orderChats(updated, "manual", stored).map(x => x.id)).toEqual(stored);
    const moved = moveKey(stored, "lower", 1)!;
    expect(orderChats(chats, "manual", moved).map(x => x.id)).toEqual(moved);
  });

  it("uses a stable tie break when the metadata-sorted source order changes", () => {
    const a = { ...older, id: "a" }, b = { ...older, id: "b" };
    expect(orderChats([a, b], "activity").map(x => x.id)).toEqual(orderChats([b, a], "activity").map(x => x.id));
  });

  it("does not access session storage on native", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    const getter = vi.fn(() => { throw new Error("Native must not read web storage"); });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: getter });
    try {
      (await import("../client/chat-activity")).observeChatActivity("host", newer);
      expect(getter).not.toHaveBeenCalled();
    } finally { delete (globalThis as { sessionStorage?: unknown }).sessionStorage; vi.doMock("react-native", () => ({ Platform: { OS: "web" } })); }
  });
});
