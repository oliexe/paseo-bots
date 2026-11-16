import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InteractionStore } from "../server/interactions";
import { showCard } from "../server/tools/interactions";
import { BOT_LABEL } from "../shared/bot";
import { botToolName, QUIET_TOOLS } from "../shared/bot-tools";
import {
  INTERACTION_CARD, INTERACTION_DATA_BYTES, InteractionSchema, InteractionSpecSchema, initialInteractionResponse, jsonUtf8Bytes,
  interactionReplyText, interactionReplySummary, interactionIdOf, isCalendarDate, responseSignature, validateInteractionResponse,
  type Interaction, type InteractionResponse, type InteractionSpec,
} from "../shared/interaction";
import { appendDraftText } from "../client/chat/composer/logic";
import { buildRows, findRows, layoutStream, type StreamEntry } from "../client/chat/stream/model";
import { fakeHost, makeBot } from "./helpers";

const draft = (extra: Record<string, unknown> = {}): InteractionSpec => InteractionSpecSchema.parse({ kind: "draft", title: "Reply to Ada", text: "Hello Ada,\n\nTuesday works.", ...extra });
const confirm = (): InteractionSpec => InteractionSpecSchema.parse({ kind: "confirm", title: "Send the message?", preview: "To: Ada", actions: [{ id: "approve", label: "Send message", primary: true }, { id: "revise", label: "Make changes" }] });
const answer = (spec: InteractionSpec, patch: Partial<InteractionResponse> = {}): InteractionResponse => ({ ...initialInteractionResponse(spec), ...patch });

describe("interactive card contracts", () => {
  it("exports an MCP JSON schema for all four card kinds", () => {
    const schema = z.toJSONSchema(showCard.input);
    expect(JSON.stringify(schema)).toContain('"draft"');
    expect(JSON.stringify(schema)).toContain('"form"');
    expect(botToolName("mcp__bots__show_card")).toBe("show_card");
    expect(QUIET_TOOLS).toContain("show_card");
  });

  it("rejects duplicate, reserved, oversized and unrelated fields", () => {
    expect(() => InteractionSpecSchema.parse({ kind: "choice", title: "Pick", options: [{ id: "one", label: "One" }, { id: "one", label: "Duplicate" }] })).toThrow("unique");
    expect(() => InteractionSpecSchema.parse({ kind: "confirm", title: "Pick", actions: [{ id: "dismiss", label: "Yes" }] })).toThrow("reserved");
    expect(() => draft({ fields: [{ id: "constructor", label: "Name", kind: "text" }] })).toThrow();
    expect(() => draft({ text: "a".repeat(50_001) })).toThrow();
    expect(() => draft({ execute: "rm something" })).toThrow();
  });

  it("validates dates without timezone shifts or JavaScript's year-0-to-99 quirk", () => {
    for (const valid of ["2028-02-29", "2000-02-29", "0001-01-01", "2026-11-16"]) expect(isCalendarDate(valid)).toBe(true);
    for (const invalid of ["2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-11-00", "0000-01-01", "26-01-01", "2026-1-1"]) expect(isCalendarDate(invalid)).toBe(false);
  });

  it("validates forms against the original fields, required values and allowed options", () => {
    const spec = InteractionSpecSchema.parse({ kind: "form", title: "Meeting", fields: [
      { id: "name", label: "Name", kind: "text", required: true },
      { id: "day", label: "Day", kind: "date" },
      { id: "place", label: "Place", kind: "select", options: ["Office", "Remote"] },
    ] });
    expect(() => validateInteractionResponse(spec, answer(spec))).toThrow("Name is required");
    expect(() => validateInteractionResponse(spec, answer(spec, { values: { name: "  " } }))).toThrow("required");
    expect(() => validateInteractionResponse(spec, answer(spec, { values: { name: "Ada", day: "2026-02-30" } }))).toThrow("real date");
    expect(() => validateInteractionResponse(spec, answer(spec, { values: { name: "Ada", place: "Elsewhere" } }))).toThrow("available value");
    expect(() => validateInteractionResponse(spec, answer(spec, { values: { name: "Ada", surprise: "x" } }))).toThrow("does not contain");
    expect(validateInteractionResponse(spec, answer(spec, { values: { name: "Ada", day: "2026-11-16", place: "Remote" } })).values).toEqual({ name: "Ada", day: "2026-11-16", place: "Remote" });
    expect(() => InteractionSpecSchema.parse({ kind: "form", title: "Meeting", fields: [{ id: "place", label: "Place", kind: "select", options: ["Office"], value: "Elsewhere" }] })).toThrow("initial value");
  });

  it("requires one choice unless the card permits several, and rejects fabricated choices", () => {
    const spec = InteractionSpecSchema.parse({ kind: "choice", title: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    expect(() => validateInteractionResponse(spec, answer(spec))).toThrow("at least one");
    expect(() => validateInteractionResponse(spec, answer(spec, { selected: ["a", "b"] }))).toThrow("one option");
    expect(() => validateInteractionResponse(spec, answer(spec, { selected: ["unknown"] }))).toThrow("available options");
    const multiple = InteractionSpecSchema.parse({ ...spec, multiple: true });
    expect(() => validateInteractionResponse(multiple, answer(multiple, { selected: ["a", "a"] }))).toThrow("once each");
    expect(validateInteractionResponse(multiple, answer(multiple, { selected: ["b", "a"] })).selected).toEqual(["a", "b"]);
  });

  it("preserves edited drafts exactly and allows only the actions the card offered", () => {
    const spec = draft();
    const edited = "Hello Ada,\n\nWednesday works.\n";
    expect(validateInteractionResponse(spec, answer(spec, { text: edited })).text).toBe(edited);
    expect(() => validateInteractionResponse(spec, answer(spec, { text: "  " }))).toThrow("empty");
    expect(() => validateInteractionResponse(confirm(), answer(confirm(), { action: "invented" }))).toThrow("available actions");
    expect(() => validateInteractionResponse(confirm(), answer(confirm(), { action: "approve", text: "surprise" }))).toThrow("draft text");
    expect(validateInteractionResponse(spec, { action: "dismiss" }).action).toBe("dismiss");
    expect(() => validateInteractionResponse(spec, answer(spec, { action: "dismiss" }))).toThrow("dismissal cannot contain answers");
  });

  it("compares retries independently of object-key and multi-choice order", () => {
    const first = { action: "submit", values: { b: "2", a: "1" }, selected: ["b", "a"], text: "" };
    const second = { action: "submit", values: { a: "1", b: "2" }, selected: ["a", "b"], text: "" };
    expect(responseSignature(first)).toBe(responseSignature(second));
    expect(responseSignature(first)).not.toBe(responseSignature({ ...second, text: "other" }));
  });

  it("adds a reviewed draft without replacing an unfinished reply", () => {
    expect(appendDraftText("My comments  ", "Reviewed draft\n")).toBe("My comments\n\nReviewed draft\n");
    expect(appendDraftText("", "Reviewed draft")).toBe("Reviewed draft");
    expect(appendDraftText("Keep me", " \n")).toBe("Keep me");
  });

  it("budgets real UTF-8 JSON bytes for both the original card and its final answer", () => {
    for (const value of ["ordinary", "Žluťoučký", "漢字", "🐕", "\u0000\n\t\"\\", "\ud800"]) expect(jsonUtf8Bytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    expect(() => draft({ text: "🐕".repeat(8000) })).toThrow("too large for chat");
    expect(() => draft({ text: "\u0000".repeat(5000) })).toThrow("too large for chat");
    expect(() => draft({ fields: Array.from({ length: 8 }, (_, index) => ({ id: `field${index}`, label: "Field", kind: "text", value: "a".repeat(4000) })) })).toThrow("too large for chat");
    const spec = draft({ text: "a".repeat(26_000) });
    expect(() => validateInteractionResponse(spec, answer(spec, { text: "🐕".repeat(8000) }))).toThrow("answer is too large");
    const stored = InteractionSchema.parse({ id: "i-123456789012345678901234", botId: "b".repeat(200), agentId: "a".repeat(200), spec, response: answer(spec, { text: "b".repeat(26_000) }), status: "submitting", createdAt: "2026-11-16T12:00:00Z", resolvedAt: null, error: "漢".repeat(1000) });
    expect(jsonUtf8Bytes(stored)).toBeLessThan(INTERACTION_DATA_BYTES);
  });
});

describe("interactive card delivery", () => {
  let root: string;
  let next = 0;
  beforeAll(async () => {
    const temporaryRoot = process.env.HS_TEMP || join(homedir(), "Temp");
    await mkdir(temporaryRoot, { recursive: true });
    root = await mkdtemp(join(temporaryRoot, "paseo-bots-interactions-"));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function fixture() {
    const directory = join(root, `store-${next++}`);
    const store = new InteractionStore(() => directory);
    const host = fakeHost([makeBot()]);
    const sent: { text: string; options: { messageId: string } }[] = [];
    const projected = new Map<string, unknown>();
    const append = vi.fn(async (item: unknown) => { const row = item as { id: string }; projected.set(row.id, { ...row, pluginId: "paseo-bots" }); });
    const refetch = vi.fn(async () => ({ entries: [...projected.values()].map((item) => ({ item })), hasOlder: false, error: null, startCursor: null }));
    const send = vi.fn(async (text: string, options: { messageId: string }) => { sent.push({ text, options }); });
    const refresh = vi.fn(async () => ({ agent: { labels: { [BOT_LABEL]: "bot-1" }, archivedAt: null as string | null } }));
    const ref = vi.fn((_id: string) => ({ send, refresh, timeline: { append, refetch } }));
    host.attach({ agents: { ref } } as never);
    const create = (spec: InteractionSpec = draft(), key?: string) => store.create({ botId: "bot-1", agentId: "chat-1", spec, key }, host.requirePaseo());
    return { directory, store, host, sent, append, send, refresh, ref, create, projected, refetch };
  }

  it("restores lost cards after a provider reset without delivering answers or duplicating live rows", async () => {
    const f = fixture();
    const card = await f.create();
    expect(await f.store.restore("chat-1", f.host)).toBe(0);
    f.projected.clear();
    expect(await f.store.restore("chat-1", f.host)).toBe(1);
    expect(f.projected.size).toBe(1);
    expect(await f.store.restore("chat-1", f.host)).toBe(0);
    expect(f.send).not.toHaveBeenCalled();
    expect((f.projected.get(card.id) as { data: Interaction }).data.status).toBe("pending");
    expect(await f.store.restore("another-chat", f.host)).toBe(0);
    f.refresh.mockResolvedValueOnce({ agent: { labels: { [BOT_LABEL]: "different-bot" }, archivedAt: null } });
    expect(await f.store.restore("chat-1", f.host)).toBe(0);
  });

  it("recovery waits for an in-flight answer and publishes its final state", async () => {
    const f = fixture();
    const card = await f.create();
    let release!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    f.send.mockImplementationOnce(async () => { notify(); await new Promise<void>((resolve) => { release = resolve; }); });
    const sending = f.store.respond(card.id, "chat-1", answer(card.spec), f.host);
    await started;
    f.projected.clear();
    const recovering = f.store.restore("chat-1", f.host);
    release();
    await sending;
    await recovering;
    expect((f.projected.get(card.id) as { data: Interaction }).data.status).toBe("answered");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not append while the history read has failed", async () => {
    const f = fixture();
    await f.create();
    f.append.mockClear();
    f.refetch.mockRejectedValueOnce(new Error("Offline"));
    await expect(f.store.restore("chat-1", f.host)).rejects.toThrow("Offline");
    expect(f.append).not.toHaveBeenCalled();
  });

  it("persists a native timeline card and sends concurrent answers to its original agent once", async () => {
    const f = fixture();
    const card = await f.create();
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ type: "plugin", id: card.id, ...INTERACTION_CARD, data: expect.objectContaining({ status: "pending" }) }));
    const response = answer(card.spec, { text: "An edited answer" });
    const results = await Promise.all(Array.from({ length: 5 }, () => f.store.respond(card.id, "chat-1", response, f.host)));
    expect(results.every((entry) => entry.status === "answered")).toBe(true);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain('"draft": "An edited answer"');
    expect(f.sent[0]!.options.messageId).toBe(`bots-card-${card.id}`);
    expect(f.ref.mock.calls.every(([id]) => id === "chat-1")).toBe(true);
    expect(JSON.parse(await readFile(join(f.directory, `${card.id}.json`), "utf8")).status).toBe("answered");
    if (process.platform !== "win32") expect((await stat(join(f.directory, `${card.id}.json`))).mode & 0o777).toBe(0o600);
  });

  it("refuses oversized or linked card files without blocking unrelated cards", async () => {
    const f = fixture();
    const card = await f.create();
    const path = join(f.directory, `${card.id}.json`);
    await writeFile(path, JSON.stringify(card) + " ".repeat(INTERACTION_DATA_BYTES));
    await expect(f.store.get(card.id, "chat-1")).rejects.toThrow("exceeds the 64 KB limit");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await f.create()).status).toBe("pending");
    const outside = join(root, `outside-${next++}.json`);
    await writeFile(outside, JSON.stringify(card));
    await rm(path);
    await symlink(outside, path);
    await expect(f.store.get(card.id, "chat-1")).rejects.toThrow();
    expect((await f.create()).status).toBe("pending");
    expect(await readFile(outside, "utf8")).toBe(JSON.stringify(card));
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("refuses a symbolic link as the card directory before reading or writing its target", async () => {
    const f = fixture();
    const outside = join(root, `outside-${next++}`);
    await mkdir(outside);
    await symlink(outside, f.directory);
    await expect(f.create()).rejects.toThrow("not a link or file");
    await expect(f.store.get("i-123456789012345678901234", "chat-1")).rejects.toThrow("not a link or file");
    await expect(f.store.pruneDeletedBots(new Set())).rejects.toThrow("not a link or file");
    expect(await readdir(outside)).toEqual([]);
    expect(f.append).not.toHaveBeenCalled();
  });

  it("reuses an idempotent create key and refuses changed content with that key", async () => {
    const f = fixture();
    const cards = await Promise.all([f.create(draft(), "reply-1"), f.create(draft(), "reply-1")]);
    expect(cards[0]!.id).toBe(cards[1]!.id);
    await expect(f.create(draft({ text: "Changed" }), "reply-1")).rejects.toThrow("different card");
  });

  it("waits for an in-flight answer before republishing an idempotently created card", async () => {
    const f = fixture();
    const card = await f.create(draft(), "reply-1");
    let finishSend!: () => void;
    let startedSend!: () => void;
    const started = new Promise<void>((resolve) => { startedSend = resolve; });
    f.send.mockImplementationOnce(async () => {
      startedSend();
      await new Promise<void>((resolve) => { finishSend = resolve; });
    });
    const responding = f.store.respond(card.id, "chat-1", answer(card.spec), f.host);
    await started;
    const creating = f.create(draft(), "reply-1");
    finishSend();
    await responding;
    expect((await creating).status).toBe("answered");
    expect(f.append.mock.calls.at(-1)?.[0]).toMatchObject({ data: { status: "answered" } });
  });

  it("freezes a failed delivery, survives restart and retries the same message id", async () => {
    const f = fixture();
    const card = await f.create();
    const response = answer(card.spec, { text: "Approved exact text" });
    f.send.mockRejectedValueOnce(new Error("Connection lost after sending"));
    await expect(f.store.respond(card.id, "chat-1", response, f.host)).rejects.toThrow("Connection lost");
    expect(await f.store.get(card.id, "chat-1")).toMatchObject({ status: "submitting", response, error: "Connection lost after sending" });
    const restarted = new InteractionStore(() => f.directory);
    await expect(restarted.respond(card.id, "chat-1", answer(card.spec, { text: "Changed" }), f.host)).rejects.toThrow("different answer");
    expect((await restarted.respond(card.id, "chat-1", undefined, f.host)).status).toBe("answered");
    expect(f.send.mock.calls[0]![1]).toEqual(f.send.mock.calls[1]![1]);
    expect(f.send.mock.calls[0]![0]).toEqual(f.send.mock.calls[1]![0]);
  });

  it("does not send stale, cross-chat, archived, deleted or relabeled cards", async () => {
    const f = fixture();
    const card = await f.create();
    const response = answer(card.spec);
    await expect(f.store.get(card.id, "another-chat")).rejects.toThrow("another chat");
    await expect(f.store.respond(card.id, "another-chat", response, f.host)).rejects.toThrow("another chat");
    f.refresh.mockResolvedValueOnce({ agent: { labels: { [BOT_LABEL]: "another-bot" }, archivedAt: null } });
    await expect(f.store.respond(card.id, "chat-1", response, f.host)).rejects.toThrow("original chat");
    f.refresh.mockResolvedValueOnce({ agent: { labels: { [BOT_LABEL]: "bot-1" }, archivedAt: "2026-11-16" } });
    await expect(f.store.respond(card.id, "chat-1", response, f.host)).rejects.toThrow("Restore this chat");
    (await f.host.values())!.bots[0]!.archived = true;
    await expect(f.store.respond(card.id, "chat-1", response, f.host)).rejects.toThrow("bot is no longer");
    await expect(f.store.respond("i-000000000000000000000000", "chat-1", response, f.host)).rejects.toThrow("no longer available");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("records dismissals and rejects any later attempt to approve them", async () => {
    const f = fixture();
    const card = await f.create(confirm());
    const response = { action: "dismiss", values: {}, selected: [], text: "" };
    const result = await f.store.respond(card.id, "chat-1", response, f.host);
    expect(result.status).toBe("dismissed");
    expect(result.resolvedAt).toBeTruthy();
    expect(f.sent[0]!.text).toContain("Do not perform the proposed action");
    await expect(f.store.respond(card.id, "chat-1", answer(card.spec, { action: "approve" }), f.host)).rejects.toThrow("different answer");
    expect((await f.store.respond(card.id, "chat-1", response, f.host)).status).toBe("dismissed");
    expect(f.sent).toHaveLength(1);
  });

  it("explains an ambiguous daemon receipt without changing the answer or message id", async () => {
    const f = fixture();
    const card = await f.create();
    f.send.mockRejectedValueOnce(Object.assign(new Error("Delivery unknown"), { code: "agent_request_outcome_unknown" }));
    await expect(f.store.respond(card.id, "chat-1", answer(card.spec), f.host)).rejects.toThrow("Delivery unknown");
    expect(await f.store.get(card.id, "chat-1")).toMatchObject({ status: "submitting", error: expect.stringContaining("Check this chat before taking further action") });
  });

  it("leaves pending cards unchanged when response validation fails", async () => {
    const f = fixture();
    const card = await f.create();
    await expect(f.store.respond(card.id, "chat-1", answer(card.spec, { text: "" }), f.host)).rejects.toThrow("empty");
    expect((await f.store.get(card.id, "chat-1"))?.status).toBe("pending");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not create an orphan if the initial timeline append fails", async () => {
    const f = fixture();
    f.append.mockRejectedValueOnce(new Error("No timeline"));
    await expect(f.create(draft(), "retry-safe")).rejects.toThrow("No timeline");
    expect((await f.create(draft(), "retry-safe")).status).toBe("pending");
  });

  it("does not undo successful delivery when refreshing the timeline fails", async () => {
    const f = fixture();
    const card = await f.create();
    f.append.mockRejectedValue(new Error("Timeline offline"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.store.respond(card.id, "chat-1", answer(card.spec), f.host)).status).toBe("answered");
      expect((await f.store.get(card.id, "chat-1"))?.status).toBe("answered");
      expect(f.sent).toHaveLength(1);
    } finally { logged.mockRestore(); }
  });

  it("rejects path traversal and corrupt records instead of silently overwriting them", async () => {
    const f = fixture();
    await expect(f.store.get("../../secrets", "chat-1")).rejects.toThrow();
    const card = await f.create();
    await writeFile(join(f.directory, `${card.id}.json`), "broken json");
    await expect(f.store.respond(card.id, "chat-1", answer(card.spec), f.host)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("isolates corrupt records without overwriting their keys or blocking unrelated cards", async () => {
    const f = fixture();
    const card = await f.create(draft(), "corrupted");
    const path = join(f.directory, `${card.id}.json`);
    await writeFile(path, "broken json");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.create(draft({ title: "Unrelated card" }), "new")).status).toBe("pending");
      await expect(f.create(draft(), "corrupted")).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("broken json");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally { logged.mockRestore(); }
  });

  it("prunes deleted bots' pending and settled cards while retaining existing bots", async () => {
    const f = fixture();
    const pending = await f.create();
    const settled = await f.create();
    await f.store.respond(settled.id, "chat-1", answer(settled.spec), f.host);
    const retained = await f.store.create({ botId: "retained", agentId: "other-chat", spec: draft() }, f.host.requirePaseo());
    await f.store.pruneDeletedBots(new Set(["retained"]));
    expect(await f.store.get(pending.id, "chat-1")).toBeNull();
    expect(await f.store.get(settled.id, "chat-1")).toBeNull();
    expect(await f.store.get(retained.id, "other-chat")).toEqual(retained);
    await expect(f.store.respond(pending.id, "chat-1", answer(pending.spec), f.host)).rejects.toThrow("no longer available");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("caps unanswered cards while letting the user resolve them", async () => {
    const f = fixture();
    const cards: Interaction[] = [];
    for (let i = 0; i < 20; i++) cards.push(await f.create(draft({ title: `Draft ${i}` })));
    await expect(f.create()).rejects.toThrow("20 unanswered");
    const first = cards[0]!;
    await f.store.respond(first.id, "chat-1", answer(first.spec), f.host);
    expect((await f.create()).status).toBe("pending");
  });
});

describe("interactive timeline presentation", () => {
  const card = InteractionSchema.parse({ id: "i-123456789012345678901234", botId: "bot-1", agentId: "chat-1", spec: draft(), status: "pending", response: null, createdAt: "2026-11-16T12:00:00Z", resolvedAt: null, error: null });
  const entry = (item: StreamEntry["item"], seq: number): StreamEntry => ({ provider: "codex", item, timestamp: card.createdAt, seqStart: seq, seqEnd: seq });

  it("shows typed cards, hides their completed tool call, and makes their contents searchable", () => {
    const entries = [
      entry({ type: "tool_call", callId: "call-1", name: "bots.show_card", status: "completed", detail: { type: "unknown", input: null, output: JSON.stringify({ cardId: card.id, status: "pending" }) } }, 1),
      entry({ type: "plugin", pluginId: "paseo-bots", id: card.id, ...INTERACTION_CARD, data: card }, 2),
    ];
    const rows = buildRows(entries, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "interaction", key: `interaction:${card.id}` });
    expect(findRows(layoutStream(rows, false).items, "tuesday")).toEqual([0]);
  });

  it("only hides a completed card tool while its matching card is present", () => {
    const tool = { name: "bots.show_card", status: "completed", detail: { type: "unknown", output: { content: [{ type: "text", text: JSON.stringify({ cardId: card.id, status: "pending" }) }] } } };
    expect(interactionIdOf(tool)).toBe(card.id);
    expect(interactionIdOf({ ...tool, name: "other.show_card" })).toBeNull();
    expect(interactionIdOf({ ...tool, error: "Failed" })).toBeNull();
    expect(interactionIdOf({ ...tool, detail: { output: { cardId: card.id, status: "pending", isError: true } } })).toBeNull();
    expect(interactionIdOf({ ...tool, detail: { output: `Mention ${card.id}` } })).toBeNull();
    expect(buildRows([entry({ type: "tool_call", ...tool }, 1)], false)).toMatchObject([{ kind: "tool" }]);
  });

  it("keeps failed tools visible and ignores malformed, foreign or future-version cards", () => {
    const entries = [
      entry({ type: "tool_call", callId: "call-1", name: "bots.show_card", status: "failed", error: "No timeline" }, 1),
      entry({ type: "tool_call", callId: "call-2", name: "bots.show_card", status: "completed", error: "MCP execution failed" }, 2),
      entry({ type: "plugin", pluginId: "other", id: card.id, ...INTERACTION_CARD, data: card }, 2),
      entry({ type: "plugin", pluginId: "paseo-bots", id: card.id, ...INTERACTION_CARD, data: {} }, 3),
      entry({ type: "plugin", pluginId: "paseo-bots", id: card.id, kind: INTERACTION_CARD.kind, version: 99, data: card }, 4),
    ];
    expect(buildRows(entries, false)).toMatchObject([{ kind: "tool", status: "failed" }, { kind: "tool", status: "completed", error: "MCP execution failed" }]);
  });

  it("sends chosen labels along with stable ids and the exact approved draft", () => {
    const text = interactionReplyText(card, answer(card.spec, { text: "Changed exactly\n" }));
    expect(text).toContain('"draft": "Changed exactly\\n"');
    expect(text).toContain(card.id);
    expect(text).toContain("grants no permissions beyond");
  });

  it("renders verified replies readably while preserving the complete original message and search", () => {
    const answered = { ...card, status: "answered" as const, response: answer(card.spec, { text: "Hello Ada!\nTuesday at noon." }) };
    const text = interactionReplyText(answered, answered.response);
    const messageId = `bots-card-${card.id}`;
    const rows = buildRows([
      entry({ type: "plugin", pluginId: "paseo-bots", ...INTERACTION_CARD, data: answered }, 1),
      entry({ type: "user_message", text, messageId, clientMessageId: messageId }, 2),
    ], false);
    expect(rows[1]).toMatchObject({ kind: "user", text, messageId, cardReply: "Reply to Ada\n\nApproved draft\n\nHello Ada!\nTuesday at noon." });
    expect(findRows(layoutStream(rows, false).items, "grants no permissions")).toEqual([1]);
    expect(findRows(layoutStream(rows, false).items, "approved draft")).toEqual([1]);
    expect(interactionReplySummary(answered, text, [messageId])).toBeTruthy();
  });

  it("keeps nonmatching, copied, malformed, missing and foreign card replies as plain messages", () => {
    const answered = { ...card, status: "answered" as const, response: answer(card.spec) };
    const text = interactionReplyText(answered, answered.response);
    const messageId = `bots-card-${card.id}`;
    for (const message of [
      { text }, { text, messageId: "other" }, { text, messageId, clientMessageId: "other" }, { text: `${text} Changed`, messageId },
    ]) {
      const rows = buildRows([entry({ type: "plugin", pluginId: "paseo-bots", ...INTERACTION_CARD, data: answered }, 1), entry({ type: "user_message", ...message }, 2)], false);
      expect(rows[1]).not.toHaveProperty("cardReply");
    }
    for (const item of [
      { type: "plugin", pluginId: "other", ...INTERACTION_CARD, data: answered },
      { type: "plugin", pluginId: "paseo-bots", ...INTERACTION_CARD, data: card },
      { type: "plugin", pluginId: "paseo-bots", ...INTERACTION_CARD, data: { ...answered, response: { ...answered.response, selected: ["invented"] } } },
    ]) {
      const rows = buildRows([entry(item, 1), entry({ type: "user_message", text, messageId }, 2)], false);
      expect(rows.at(-1)).not.toHaveProperty("cardReply");
    }
    expect(buildRows([entry({ type: "user_message", text, messageId }, 2)], false)[0]).not.toHaveProperty("cardReply");
  });

  it("uses original action and field labels, choice order, and dismissal semantics", () => {
    const summary = (spec: InteractionSpec, patch: Partial<InteractionResponse>) => {
      const response = validateInteractionResponse(spec, answer(spec, patch));
      const answered = { ...card, spec, response, status: response.action === "dismiss" ? "dismissed" as const : "answered" as const };
      return interactionReplySummary(answered, interactionReplyText(answered, response), [`bots-card-${card.id}`]);
    };
    expect(summary(confirm(), { action: "revise" })).toBe("Send the message?\nMake changes");
    const choice = InteractionSpecSchema.parse({ kind: "choice", title: "Colours", multiple: true, options: [{ id: "z", label: "Red" }, { id: "a", label: "Blue" }] });
    expect(summary(choice, { selected: ["a", "z"] })).toBe("Colours\nRed, Blue");
    const form = InteractionSpecSchema.parse({ kind: "form", title: "Meeting", fields: [{ id: "person", label: "Full name", kind: "text" }, { id: "day", label: "Date", kind: "date" }] });
    expect(summary(form, { values: { person: "Ada" } })).toBe("Meeting\n\nAnswers submitted\n\nFull name: Ada\nDate: Not provided");
    expect(summary(draft(), { action: "dismiss", text: "" })).toBe("Reply to Ada\nDismissed");
  });
});
