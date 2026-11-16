import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HandoffNotifications } from "../server/handoff-notifications";
import { BOT_LABEL } from "../shared/bot";
import { ASKED_BY_LABEL, ASKED_IN_LABEL, ASK_NOTIFY_LABEL, HANDOFF_REQUEST_METADATA } from "../shared/handoff";
import { fakeHost, makeBot } from "./helpers";

let temporary: string;
beforeAll(async () => {
  const root = process.env.HS_TEMP || join(homedir(), "Temp");
  await mkdir(root, { recursive: true });
  temporary = await mkdtemp(join(root, "bots-handoff-tests-"));
});
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

function fixture(directory: string) {
  const bots = [makeBot({ id: "lead", name: "Lead" }), makeBot({ id: "worker", name: "Worker" })];
  const host = fakeHost(bots);
  const agents: Record<string, { labels: Record<string, string>; archivedAt?: string; status?: string; pendingPermissions?: unknown[]; metadata?: Record<string, unknown> }> = {
    asking: { labels: { [BOT_LABEL]: "lead" } },
    working: { labels: { [BOT_LABEL]: "worker", [ASKED_BY_LABEL]: "lead", [ASKED_IN_LABEL]: "asking", [ASK_NOTIFY_LABEL]: "true" } },
  };
  const send = vi.fn(async (_id: string, _text: string, _options: unknown) => {});
  const timeline = vi.fn(async () => ({ entries: [
    { seqEnd: 1, turnId: "old-turn", item: { type: "assistant_message", text: "Old answer, never quote this." } },
    { seqEnd: 2, turnId: "turn-1", item: { type: "assistant_message", text: "The worker finished its task." } },
  ] }));
  const refresh = vi.fn(async (id: string) => agents[id] ? { agent: { id, ...agents[id] } } : null);
  const paseo = { agents: { ref: (id: string) => ({
    refresh: () => refresh(id),
    send: (text: string, options: unknown) => send(id, text, options), timeline: { refetch: timeline },
  }) } } as never;
  host.attach(paseo);
  const notifications = new HandoffNotifications(host, directory);
  const event = { agent: { id: "working" }, turnId: "turn-1", outcome: { kind: "completed" as const } };
  return { bots, host, agents, refresh, send, timeline, paseo, notifications, event };
}

describe("delegation completion notifications", () => {
  it("wakes exactly the asking chat with a bounded turn-specific answer and stable receipt", async () => {
    const f = fixture(join(temporary, "completed"));
    await Promise.all([f.notifications.finished(f.event, f.paseo), f.notifications.finished(f.event, f.paseo)]);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith("asking", expect.stringContaining("Worker finished (chat working)"), {
      sourceAgentId: "working", messageId: expect.stringMatching(/^bots-handoff-[a-f0-9]{64}$/), activeTurnBehavior: "steer",
    });
    expect(f.send.mock.calls[0]![1]).toContain("The worker finished its task.");
    expect(f.send.mock.calls[0]![1]).not.toContain("Old answer");
    await f.notifications.stop();
    const restarted = new HandoffNotifications(f.host, join(temporary, "completed"));
    await restarted.retry();
    await restarted.finished(f.event, f.paseo);
    expect(f.send).toHaveBeenCalledOnce();
    await restarted.stop();
  });

  it("replays the identical frozen payload after an ambiguous send error and restart", async () => {
    const directory = join(temporary, "retry");
    const f = fixture(directory);
    f.send.mockRejectedValueOnce(new Error("Connection lost after accepting the message"));
    await expect(f.notifications.finished(f.event, f.paseo)).rejects.toThrow("Connection lost");
    const original = f.send.mock.calls[0];
    await f.notifications.stop();
    f.timeline.mockResolvedValue({ entries: [{ seqEnd: 3, turnId: "turn-2", item: { type: "assistant_message", text: "Different later answer" } }] });
    const restarted = new HandoffNotifications(f.host, directory);
    await restarted.retry();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]).toEqual(original);
    const files = await readdir(directory);
    expect(JSON.parse(await readFile(join(directory, files[0]!), "utf8")).settled).toBe(true);
    await restarted.stop();
  });

  it.each(["false", undefined])("does not notify opted-out or legacy chats (%s)", async (notify) => {
    const f = fixture(join(temporary, `opt-out-${notify}`));
    if (notify) f.agents.working!.labels[ASK_NOTIFY_LABEL] = notify;
    else delete f.agents.working!.labels[ASK_NOTIFY_LABEL];
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.timeline).not.toHaveBeenCalled();
    await f.notifications.stop();
  });

  it.each(["foreign", "missing", "archived", "deleted-bot", "archived-bot", "archived-worker"])("never revives an unavailable or foreign requester: %s", async (kind) => {
    const f = fixture(join(temporary, kind));
    if (kind === "foreign") f.agents.asking!.labels[BOT_LABEL] = "stranger";
    if (kind === "missing") delete f.agents.asking;
    if (kind === "archived") f.agents.asking!.archivedAt = "2026-01-01";
    if (kind === "deleted-bot") f.bots.shift();
    if (kind === "archived-bot") f.bots[0]!.archived = true;
    if (kind === "archived-worker") f.agents.working!.archivedAt = "2026-01-01";
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).not.toHaveBeenCalled();
    await f.notifications.stop();
  });

  it("reports failure and cancellation, but never presents a stale turn as the answer", async () => {
    const f = fixture(join(temporary, "outcomes"));
    await f.notifications.finished({ ...f.event, turnId: "turn-failed", outcome: { kind: "failed", error: { message: "Provider disconnected" } } }, f.paseo);
    await f.notifications.finished({ ...f.event, turnId: "turn-canceled", outcome: { kind: "canceled", reason: "user" } }, f.paseo);
    expect(f.send.mock.calls[0]![1]).toContain("stopped with an error: Provider disconnected");
    expect(f.send.mock.calls[1]![1]).toContain("was stopped before completing the request");
    for (const [, text] of f.send.mock.calls) expect(text).not.toContain("The worker finished its task.");
    await f.notifications.stop();
  });

  it("still provides the handle when the timeline is temporarily unavailable", async () => {
    const f = fixture(join(temporary, "timeline-failed"));
    f.timeline.mockRejectedValue(new Error("timeline unavailable"));
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).toHaveBeenCalledWith("asking", expect.stringContaining("Use check_chat"), expect.anything());
    await f.notifications.stop();
  });

  it("bounds large replies and isolates malformed receipts without following symlinks", async () => {
    const directory = join(temporary, "bounded");
    const f = fixture(directory);
    f.timeline.mockResolvedValue({ entries: [{ seqEnd: 2, turnId: "turn-1", item: { type: "assistant_message", text: "a".repeat(30_000) } }] });
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send.mock.calls[0]![1].length).toBeLessThan(7000);
    expect(f.send.mock.calls[0]![1]).toContain("Reply shortened");
    const outside = join(temporary, "outside.json");
    await writeFile(outside, "must not be read or replaced");
    await symlink(outside, join(directory, `${"a".repeat(64)}.json`));
    await writeFile(join(directory, `${"b".repeat(64)}.json`), "invalid");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await f.notifications.retry();
    expect(log).toHaveBeenCalledTimes(2);
    expect(await readFile(outside, "utf8")).toBe("must not be read or replaced");
    log.mockRestore();
    await f.notifications.stop();
  });

  it("does not send after disposal", async () => {
    const f = fixture(join(temporary, "stopped"));
    await f.notifications.stop();
    await f.notifications.finished(f.event, f.paseo);
    await f.notifications.retry();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rechecks ownership before retrying a pending completion", async () => {
    const f = fixture(join(temporary, "revoked"));
    f.send.mockRejectedValueOnce(new Error("offline"));
    await expect(f.notifications.finished(f.event, f.paseo)).rejects.toThrow("offline");
    f.agents.asking!.labels[BOT_LABEL] = "different-bot";
    await f.notifications.retry();
    expect(f.send).toHaveBeenCalledOnce();
    await f.notifications.stop();
  });

  it("retains a pending completion while settings are unavailable", async () => {
    const f = fixture(join(temporary, "settings-unavailable"));
    const read = vi.spyOn(f.host.settings, "read");
    read.mockResolvedValue({ status: "invalid", issues: [] } as never);
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).not.toHaveBeenCalled();
    read.mockRestore();
    await f.notifications.retry();
    expect(f.send).toHaveBeenCalledOnce();
    await f.notifications.stop();
  });

  it.each(["running", "initializing", "permission"])("waits for an idle requester without interrupting %s", async (status) => {
    const f = fixture(join(temporary, `busy-${status}`));
    f.agents.asking!.status = status === "permission" ? "idle" : status;
    f.agents.asking!.pendingPermissions = status === "permission" ? [{}] : [];
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).not.toHaveBeenCalled();
    f.agents.asking!.status = "idle";
    f.agents.asking!.pendingPermissions = [];
    await f.notifications.retry();
    expect(f.send).toHaveBeenCalledOnce();
    await f.notifications.stop();
  });

  it.each(["refresh", "settings"])("recovers a pre-receipt %s failure after a plugin reload", async (failure) => {
    const directory = join(temporary, `capture-${failure}`);
    const f = fixture(directory);
    const read = vi.spyOn(f.host.settings, "read");
    if (failure === "refresh") f.refresh.mockRejectedValueOnce(new Error("offline"));
    else read.mockRejectedValueOnce(new Error("offline"));
    await expect(f.notifications.finished(f.event, f.paseo)).rejects.toThrow("offline");
    expect((await readdir(directory)).some((name) => name.startsWith("capture-"))).toBe(true);
    await f.notifications.stop();
    read.mockRestore();
    const restarted = new HandoffNotifications(f.host, directory);
    await restarted.retry();
    expect(f.send).toHaveBeenCalledOnce();
    expect((await readdir(directory)).some((name) => name.startsWith("capture-"))).toBe(false);
    await restarted.stop();
  });

  it("notifies each completed turn once, even when a chat has several turns", async () => {
    const f = fixture(join(temporary, "multi-turn"));
    await f.notifications.finished(f.event, f.paseo);
    await f.notifications.finished({ ...f.event, turnId: "turn-2" }, f.paseo);
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0]![2]).not.toEqual(f.send.mock.calls[1]![2]);
    await f.notifications.stop();
  });

  it("routes a continued conversation to its new requesting chat", async () => {
    const f = fixture(join(temporary, "continued"));
    f.agents.second = { labels: { [BOT_LABEL]: "lead" } };
    f.agents.working!.metadata = { [HANDOFF_REQUEST_METADATA]: { requesterBotId: "lead", requesterAgentId: "second", notify: true } };
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).toHaveBeenCalledWith("second", expect.any(String), expect.anything());
    await f.notifications.stop();
  });

  it("uses the ended turn's captured requester instead of newer mutable metadata", async () => {
    const f = fixture(join(temporary, "captured-requester"));
    f.agents.second = { labels: { [BOT_LABEL]: "lead" } };
    const request = { requesterBotId: "lead", requesterAgentId: "second", notify: true };
    f.agents.working!.metadata = { [HANDOFF_REQUEST_METADATA]: { ...request, requesterAgentId: "asking", notify: false } };
    await f.notifications.finished({ ...f.event, agent: { id: "working", metadata: { [HANDOFF_REQUEST_METADATA]: request } } }, f.paseo);
    expect(f.send).toHaveBeenCalledWith("second", expect.any(String), expect.anything());
    await f.notifications.stop();
  });

  it.each([false, true])("applies each follow-up's notify override (%s) to the initial label", async (notify) => {
    const f = fixture(join(temporary, `continued-notify-${notify}`));
    f.agents.working!.labels[ASK_NOTIFY_LABEL] = String(!notify);
    f.agents.working!.metadata = { [HANDOFF_REQUEST_METADATA]: { requesterBotId: "lead", requesterAgentId: "asking", notify } };
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).toHaveBeenCalledTimes(notify ? 1 : 0);
    await f.notifications.stop();
  });

  it("fails closed for metadata pointing at another bot's requester", async () => {
    const f = fixture(join(temporary, "foreign-metadata"));
    f.agents.working!.metadata = { [HANDOFF_REQUEST_METADATA]: { requesterBotId: "someone-else", requesterAgentId: "asking", notify: true } };
    await f.notifications.finished(f.event, f.paseo);
    expect(f.send).not.toHaveBeenCalled();
    await f.notifications.stop();
  });

  it("preserves captured continuation routing across a failed refresh and plugin reload", async () => {
    const directory = join(temporary, "continued-reload");
    const f = fixture(directory);
    f.agents.second = { labels: { [BOT_LABEL]: "lead" } };
    f.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(f.notifications.finished({ ...f.event, agent: { id: "working", metadata: {
      [HANDOFF_REQUEST_METADATA]: { requesterBotId: "lead", requesterAgentId: "second", notify: true },
    } } }, f.paseo)).rejects.toThrow("offline");
    await f.notifications.stop();
    const restarted = new HandoffNotifications(f.host, directory);
    await restarted.retry();
    expect(f.send).toHaveBeenCalledWith("second", expect.any(String), expect.anything());
    await restarted.stop();
  });
});
