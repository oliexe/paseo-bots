import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "../shared/attachments";
import {
  activeTurnBehaviorFor,
  applyCommand,
  commandQuery,
  composerDraftKey,
  contextUsage,
  enqueue,
  filterCommands,
  formatSessionCost,
  formatTokenCount,
  isDraftEmpty,
  meterTone,
  parseDrafts,
  parseSendBehavior,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  resolveEnterKey,
  resolveMaxInputHeight,
  resolvePrimaryAction,
  restoreFailedSend,
  ringRotations,
  serializeDrafts,
  shouldDrainQueue,
  submitAccessibilityLabel,
  takeQueued,
  type ComposerDraft,
} from "../client/chat/composer/logic";

const image = (id: string, bytes = 4): ComposerAttachment => ({ kind: "image", id, name: `${id}.png`, mimeType: "image/png", size: bytes, data: "A".repeat(bytes) });
const note = (id: string): ComposerAttachment => ({ kind: "text", id, name: `${id}.md`, size: 2, text: "hi" });

describe("send behaviour", () => {
  it("reads Paseo's sendBehavior setting, defaulting to steer", () => {
    expect(parseSendBehavior(null)).toBe("steer");
    expect(parseSendBehavior("not json")).toBe("steer");
    expect(parseSendBehavior(JSON.stringify({ sendBehavior: "queue" }))).toBe("queue");
    expect(parseSendBehavior(JSON.stringify({ sendBehavior: "interrupt", uiBaseFontSize: 14 }))).toBe("interrupt");
    expect(parseSendBehavior(JSON.stringify({ sendBehavior: "bogus" }))).toBe("steer");
  });

  it("never queues behind a pending permission", () => {
    expect(resolveActiveSendBehavior("queue", true)).toBe("interrupt");
    expect(resolveActiveSendBehavior("queue", false)).toBe("queue");
    expect(resolveActiveSendBehavior("steer", true)).toBe("steer");
  });

  it("maps the setting to the daemon's activeTurnBehavior", () => {
    expect(activeTurnBehaviorFor("steer")).toBe("steer");
    expect(activeTurnBehaviorFor("interrupt")).toBe("interrupt");
    expect(activeTurnBehaviorFor("queue")).toBe("interrupt");
  });

  it("resolves default and alternate actions like Paseo", () => {
    expect(resolveDefaultAction({ behavior: "steer", running: true, canQueue: true })).toBe("send");
    expect(resolveDefaultAction({ behavior: "queue", running: true, canQueue: true })).toBe("queue");
    expect(resolveDefaultAction({ behavior: "queue", running: false, canQueue: true })).toBe("send");
    expect(resolveAlternateAction({ behavior: "steer", running: true, canQueue: true })).toBe("queue");
    expect(resolveAlternateAction({ behavior: "steer", running: false, canQueue: true })).toBe("none");
    expect(resolveAlternateAction({ behavior: "queue", running: true, canQueue: true })).toBe("send");
  });

  it("labels the submit button", () => {
    expect(submitAccessibilityLabel({ canPressLoading: false, behavior: "steer", running: false })).toBe("Send message");
    expect(submitAccessibilityLabel({ canPressLoading: false, behavior: "steer", running: true })).toBe("Send and steer");
    expect(submitAccessibilityLabel({ canPressLoading: false, behavior: "interrupt", running: true })).toBe("Send and interrupt");
    expect(submitAccessibilityLabel({ canPressLoading: false, behavior: "queue", running: true })).toBe("Queue message");
    expect(submitAccessibilityLabel({ canPressLoading: true, behavior: "queue", running: true })).toBe("Interrupt agent");
  });

  it("hides the send button when empty and idle", () => {
    expect(resolvePrimaryAction({ hasContent: false, running: false, loading: false })).toBe("none");
    expect(resolvePrimaryAction({ hasContent: true, running: false, loading: false })).toBe("send");
    expect(resolvePrimaryAction({ hasContent: false, running: true, loading: false })).toBe("active");
    expect(resolvePrimaryAction({ hasContent: false, running: false, loading: true })).toBe("send");
  });
});

describe("enter key", () => {
  const desktop = { submitOnEnter: true, running: false, canQueue: true };
  it("sends on Enter only when enabled, never during IME composition or with Shift", () => {
    expect(resolveEnterKey({ key: "Enter" }, desktop)).toBe("default");
    expect(resolveEnterKey({ key: "Enter" }, { ...desktop, submitOnEnter: false })).toBeNull();
    expect(resolveEnterKey({ key: "Enter", shiftKey: true }, desktop)).toBeNull();
    expect(resolveEnterKey({ key: "Enter", isComposing: true }, desktop)).toBeNull();
    expect(resolveEnterKey({ key: "Enter", keyCode: 229 }, desktop)).toBeNull();
    expect(resolveEnterKey({ key: "a" }, desktop)).toBeNull();
  });

  it("uses Cmd/Ctrl+Enter for the alternate action while running", () => {
    expect(resolveEnterKey({ key: "Enter", metaKey: true }, { ...desktop, running: true })).toBe("alternate");
    expect(resolveEnterKey({ key: "Enter", ctrlKey: true }, { ...desktop, running: true })).toBe("alternate");
    expect(resolveEnterKey({ key: "Enter", metaKey: true }, desktop)).toBe("default");
  });
});

describe("input height", () => {
  it("caps at max(160, half the window)", () => {
    expect(resolveMaxInputHeight(200)).toBe(160);
    expect(resolveMaxInputHeight(1001)).toBe(500);
    expect(resolveMaxInputHeight(0)).toBe(160);
    expect(resolveMaxInputHeight(Number.NaN)).toBe(160);
  });
});

describe("queue", () => {
  it("queues non-empty messages and takes them back out", () => {
    const queue = enqueue(enqueue([], { id: "1", text: "first", attachments: [] }), { id: "2", text: "", attachments: [note("n")] });
    expect(enqueue(queue, { id: "3", text: "  ", attachments: [] })).toHaveLength(2);
    const { item, rest } = takeQueued(queue, "1");
    expect(item?.text).toBe("first");
    expect(rest.map((entry) => entry.id)).toEqual(["2"]);
    expect(takeQueued(queue, "missing").item).toBeNull();
  });

  it("drains only when idle with nothing in flight", () => {
    expect(shouldDrainQueue({ running: false, queued: 1, inFlight: false, hasAgent: true })).toBe(true);
    expect(shouldDrainQueue({ running: true, queued: 1, inFlight: false, hasAgent: true })).toBe(false);
    expect(shouldDrainQueue({ running: false, queued: 1, inFlight: true, hasAgent: true })).toBe(false);
    expect(shouldDrainQueue({ running: false, queued: 0, inFlight: false, hasAgent: true })).toBe(false);
    expect(shouldDrainQueue({ running: false, queued: 1, inFlight: false, hasAgent: false })).toBe(false);
  });
});

describe("drafts", () => {
  it("keys drafts per chat and per bot for new chats", () => {
    expect(composerDraftKey("host", "bot", "agent-1")).toBe("agent:host:agent-1");
    expect(composerDraftKey("host", "bot", null)).toBe("new:host:bot");
    expect(isDraftEmpty({ text: "", attachments: [] })).toBe(true);
    expect(isDraftEmpty({ text: " ", attachments: [] })).toBe(false);
  });

  it("round-trips drafts and drops invalid entries", () => {
    const drafts: Record<string, ComposerDraft> = {
      a: { text: "hello", attachments: [note("n1")], updatedAt: 2 },
      b: { text: "", attachments: [], updatedAt: 3 },
    };
    const parsed = parseDrafts(serializeDrafts(drafts));
    expect(Object.keys(parsed)).toEqual(["a"]);
    expect(parsed.a!.attachments[0]).toMatchObject({ kind: "text", text: "hi" });
    expect(parseDrafts(JSON.stringify({ x: { text: 5, attachments: [{ kind: "image" }] } }))).toEqual({});
    expect(parseDrafts("[1]")).toEqual({});
    expect(parseDrafts("{")).toEqual({});
  });

  it("keeps the newest drafts and sheds old images past the size budget", () => {
    const drafts: Record<string, ComposerDraft> = {
      old: { text: "old", attachments: [image("big", 5000)], updatedAt: 1 },
      mid: { text: "", attachments: [image("only", 5000)], updatedAt: 2 },
      new: { text: "new", attachments: [image("keep", 100)], updatedAt: 3 },
    };
    const parsed = parseDrafts(serializeDrafts(drafts, { maxBytes: 2000 }));
    expect(parsed.old).toMatchObject({ text: "old", attachments: [] });
    expect(parsed.mid).toBeUndefined();
    expect(parsed.new!.attachments).toHaveLength(1);
    expect(Object.keys(parseDrafts(serializeDrafts(drafts, { maxDrafts: 1 })))).toEqual(["new"]);
  });

  it("restores a failed send without losing what was typed meanwhile", () => {
    const failed = { text: "first", attachments: [note("a")] };
    expect(restoreFailedSend(failed, { text: "", attachments: [] })).toEqual(failed);
    expect(restoreFailedSend(failed, { text: "more", attachments: [note("b")] })).toEqual({ text: "first\nmore", attachments: [note("a"), note("b")] });
    expect(restoreFailedSend({ text: "", attachments: [note("a")] }, { text: "typed", attachments: [] }).text).toBe("typed");
  });
});

describe("context window meter", () => {
  it("reads usage only when the numbers are valid", () => {
    expect(contextUsage(null)).toBeNull();
    expect(contextUsage({ contextWindowMaxTokens: 0, contextWindowUsedTokens: 5 })).toBeNull();
    expect(contextUsage({ contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 50_000, totalCostUsd: 0.5 })).toEqual({ percent: 25, used: 50_000, max: 200_000, costUsd: 0.5 });
  });

  it("uses Paseo's thresholds", () => {
    expect(meterTone(69.9)).toBe("normal");
    expect(meterTone(70)).toBe("warning");
    expect(meterTone(90)).toBe("warning");
    expect(meterTone(90.1)).toBe("danger");
    expect(meterTone(150)).toBe("danger");
  });

  it("formats tokens and cost", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(84_400)).toBe("84k");
    expect(formatTokenCount(1_000_000)).toBe("1m");
    expect(formatSessionCost(0)).toBeNull();
    expect(formatSessionCost(0.004)).toBe("$0.0040");
    expect(formatSessionCost(1.234)).toBe("$1.23");
  });

  it("sweeps the ring clockwise from the top", () => {
    expect(ringRotations(0)).toEqual({ right: 225, left: null });
    expect(ringRotations(25)).toEqual({ right: 315, left: null });
    expect(ringRotations(50)).toEqual({ right: 405, left: null });
    expect(ringRotations(75)).toEqual({ right: 405, left: 135 });
    expect(ringRotations(100)).toEqual({ right: 405, left: 225 });
  });
});

describe("slash commands", () => {
  const commands = [
    { name: "review", description: "Review", argumentHint: "" },
    { name: "compact", description: "Compact", argumentHint: "" },
    { name: "pr-comments", description: "PR", argumentHint: "" },
    { name: "clear", description: "Clear", argumentHint: "" },
  ];
  it("only triggers for a lone /word", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/Re")).toBe("re");
    expect(commandQuery("/review now")).toBeNull();
    expect(commandQuery("hello /x")).toBeNull();
  });

  it("ranks prefix matches before substring matches", () => {
    expect(filterCommands(commands, "c").map((command) => command.name)).toEqual(["clear", "compact", "pr-comments"]);
    expect(filterCommands(commands, "").map((command) => command.name)).toEqual(["clear", "compact", "pr-comments", "review"]);
    expect(applyCommand(commands[0]!)).toBe("/review ");
  });
});
