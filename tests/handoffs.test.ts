import { describe, expect, it, vi } from "vitest";
import { buildRows, findRows, layoutStream, type StreamEntry } from "../client/chat/stream/model";
import { handoffStatus, publishHandoff } from "../server/handoffs";
import { BOT_LABEL } from "../shared/bot";
import { ASKED_BY_LABEL, ASKED_IN_LABEL, HANDOFF_CARD, HandoffCardSchema, type HandoffCard } from "../shared/handoff";
import { PLUGIN_ID } from "../shared/version";
import { fakeHost, makeBot } from "./helpers";

const card: HandoffCard = {
  requesterBotId: "scout", requesterAgentId: "requester", targetBotId: "inbox", targetAgentId: "target", targetName: "Inbox",
  request: "Find urgent emails", createdAt: "2026-11-16T00:00:00Z", status: { state: "running", reply: "", error: null },
};

function fixture(patch: Record<string, unknown> = {}, requesterLabels: Record<string, string> = { [BOT_LABEL]: "scout" }) {
  const target = { id: "target", status: "idle", labels: { [BOT_LABEL]: "inbox", [ASKED_BY_LABEL]: "scout", [ASKED_IN_LABEL]: "requester" }, pendingPermissions: [], lastError: null, archivedAt: null, ...patch };
  const reads = vi.fn(async (_id: string) => ({ entries: [
    { item: { type: "user_message", text: "Previous question" } },
    { item: { type: "assistant_message", text: "Old reply" } },
    { item: { type: "user_message", text: "Find urgent emails" } },
    { item: { type: "assistant_message", text: "Two urgent emails." } },
  ] }));
  const append = vi.fn(async (_input: unknown) => {});
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => id === "requester" ? { agent: { id, labels: requesterLabels } } : id === "target" ? { agent: target } : null,
    timeline: { refetch: () => reads(id), append },
  }) } };
  const host = fakeHost([makeBot({ id: "scout" }), makeBot({ id: "inbox" })]);
  host.attach(paseo as never);
  return { host, paseo, target, reads, append };
}

describe("bot handoff cards", () => {
  it.each([
    [{ status: "running" }, "running"],
    [{ status: "initializing" }, "running"],
    [{ status: "running", pendingPermissions: [{}] }, "permission"],
    [{ status: "error", lastError: "Provider disconnected" }, "error"],
    [{ status: "idle" }, "finished"],
    [{ status: "running", archivedAt: "2026-11-16T01:00:00Z" }, "archived"],
  ])("reads current status and only the latest turn: %j", async (patch, state) => {
    const { host } = fixture(patch);
    expect(await handoffStatus(host, "requester", "target")).toEqual({ state, reply: "Two urgent emails.", error: "lastError" in patch ? patch.lastError : null });
  });

  it.each([
    [{ [BOT_LABEL]: "inbox", [ASKED_BY_LABEL]: "other", [ASKED_IN_LABEL]: "requester" }, { [BOT_LABEL]: "scout" }],
    [{ [BOT_LABEL]: "inbox", [ASKED_BY_LABEL]: "scout", [ASKED_IN_LABEL]: "another-chat" }, { [BOT_LABEL]: "scout" }],
    [{ [BOT_LABEL]: "inbox", [ASKED_BY_LABEL]: "scout" }, { [BOT_LABEL]: "scout" }],
    [{ [ASKED_BY_LABEL]: "scout", [ASKED_IN_LABEL]: "requester" }, { [BOT_LABEL]: "scout" }],
    [{ [BOT_LABEL]: "inbox", [ASKED_BY_LABEL]: "scout", [ASKED_IN_LABEL]: "requester" }, {}],
  ])("refuses foreign, older unbound or relabeled handoffs before reading messages", async (labels, requesterLabels) => {
    const { host, reads } = fixture({ labels }, requesterLabels);
    await expect(handoffStatus(host, "requester", "target")).rejects.toThrow("another request");
    expect(reads).not.toHaveBeenCalled();
  });

  it("returns unavailable for removed chats, and bounds provider output for the native timeline", async () => {
    const { host, reads } = fixture({ lastError: "e".repeat(2000) });
    expect(await handoffStatus(host, "missing", "target")).toBeNull();
    expect(await handoffStatus(host, "requester", "missing")).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    reads.mockResolvedValueOnce({ entries: [{ item: { type: "assistant_message", text: "x".repeat(50_000) } }] });
    const status = await handoffStatus(host, "requester", "target");
    expect(status?.reply.length).toBeLessThanOrEqual(6000);
    expect(status?.reply.endsWith("…")).toBe(true);
    expect(status?.error).toHaveLength(1000);
    expect(HandoffCardSchema.safeParse({ ...card, status }).success).toBe(true);
  });

  it("uses a stable timeline item id and keeps publication failures isolated from dispatch", async () => {
    const { paseo, append } = fixture();
    await publishHandoff(paseo as never, card);
    await publishHandoff(paseo as never, { ...card, status: { state: "finished", reply: "Done", error: null } });
    expect(append.mock.calls.map(([input]) => (input as { id: string }).id)).toEqual(["handoff:target", "handoff:target"]);
    expect(append).toHaveBeenLastCalledWith(expect.objectContaining({ type: "plugin", ...HANDOFF_CARD, data: expect.objectContaining({ status: { state: "finished", reply: "Done", error: null } }) }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    append.mockRejectedValueOnce(new Error("timeline unavailable"));
    await expect(publishHandoff(paseo as never, card)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("renders and searches validated own-plugin cards, rejecting unsupported or malformed cards", () => {
    const entry = (item: Record<string, unknown>, seqStart: number): StreamEntry => ({ provider: "codex", timestamp: card.createdAt, seqStart, seqEnd: seqStart, item: { type: "plugin", pluginId: PLUGIN_ID, ...HANDOFF_CARD, data: card, ...item } });
    const rows = buildRows([entry({}, 1), entry({ pluginId: "other-plugin" }, 2), entry({ version: 2 }, 3), entry({ data: { ...card, targetAgentId: null } }, 4)], false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "handoff:target", kind: "handoff", card });
    const layout = layoutStream(rows, false);
    expect(findRows(layout.items, "urgent")).toEqual([0]);
    expect(findRows(layout.items, "inbox")).toEqual([0]);
    expect(layout.auxiliaryFooter).toBeNull();
  });
});
