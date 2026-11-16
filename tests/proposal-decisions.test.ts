import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideProposal } from "../client/chat/proposal-decision";
import { BOT_LABEL, type BotSettingsValues } from "../shared/bot";
import { applyProposalDecision } from "../shared/proposal-decisions";
import { ProposalSchema, type Proposal, type ProposalDecision } from "../shared/proposals";
import { pluginDataPath } from "../server/bot-home";
import * as files from "../server/files";
import { BotsHost } from "../server/host";
import { librarySkillPath, readSkill } from "../server/library";
import { acceptProposal, createProposal, dismissProposal, getProposal, prepareProposal, registerProposalNotifications, retryProposalNotifications } from "../server/proposals";
import { makeBot, NOW } from "./helpers";

let home: string;
const previousHome = process.env.PASEO_HOME;
beforeEach(async () => {
  const temporary = process.env.HS_TEMP || join(homedir(), "Temp");
  await mkdir(temporary, { recursive: true });
  home = await mkdtemp(join(temporary, "paseo-proposal-decisions-"));
  process.env.PASEO_HOME = home;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

function fixture() {
  let values: BotSettingsValues = { bots: [makeBot()], history: [] };
  const send = vi.fn(async (_text: string, _options: unknown) => {});
  const refresh = vi.fn(async () => ({ agent: { labels: { [BOT_LABEL]: "bot-1" }, archivedAt: null as string | null, status: "idle", pendingPermissions: [] as unknown[], activeTurn: null as { turnId: string } | null } }));
  const ref = vi.fn((_id: string) => ({ send, refresh }));
  const host = new BotsHost({ read: async () => ({ status: "ready", values, revision: "1" }) } as never);
  host.attach({ agents: { ref } } as never);
  const commit = vi.fn(async (mutate: (current: BotSettingsValues) => BotSettingsValues) => { values = mutate(values); return true; });
  const complete = vi.fn(async (id: string, status: ProposalDecision) => status === "accepted" ? (await acceptProposal(id, host)).proposal : dismissProposal(id, host));
  return { host, send, refresh, ref, commit, complete, values: () => values, replace: (next: BotSettingsValues) => { values = next; }, actions: { values: () => values, prepare: ({ id, receiptIds }: { id: string; receiptIds: string[] }) => prepareProposal(id, receiptIds), commit, complete } };
}

function proposal(kind: Proposal["kind"] = "changes"): Promise<Proposal> {
  const base = { botId: "bot-1", agentId: "original-chat" };
  if (kind === "skill") return createProposal({ ...base, kind, data: { name: "weekly", description: "Weekly report", text: "---\nname: weekly\ndescription: Weekly report\n---\nReport carefully.\n" } });
  if (kind === "routine") return createProposal({ ...base, kind, data: { name: "Daily", prompt: "Report", schedule: { kind: "interval", minutes: 15 }, resultsChatId: "original-chat" } });
  return createProposal({ ...base, kind, data: { summary: "Add a bot", provider: "claude", changes: [{ type: "create_bot", name: "Helper" }] } });
}

describe("proposal decisions", () => {
  it.each(["changes", "skill", "routine"] as const)("does not accept or notify a %s proposal after a failed settings save", async (kind) => {
    const f = fixture(), p = await proposal(kind);
    f.commit.mockResolvedValue(false);
    expect(await decideProposal(p, "accepted", f.actions)).toBeNull();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect((await getProposal(p.id))?.status).toBe("pending");
    expect((await readSkill({ id: "weekly" })).missing).toBe(true);
    await expect(acceptProposal(p.id, f.host)).rejects.toThrow("not been saved");
  });

  it("applies setup once and notifies only its original chat despite repeated and concurrent clicks", async () => {
    const f = fixture(), p = await proposal();
    await Promise.all([decideProposal(p, "accepted", f.actions), decideProposal(p, "accepted", f.actions)]);
    await decideProposal(p, "accepted", f.actions); // An old card still has its pending snapshot.
    expect(f.values().bots.map((bot) => bot.name)).toEqual(["Inbox", "Helper"]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.ref.mock.calls.every(([id]) => id === "original-chat")).toBe(true);
    expect(f.send).toHaveBeenCalledWith(`Proposal ${p.id} applied by the user (1 change).`, { messageId: `bots-proposal-${p.id}`, activeTurnBehavior: "steer" });
    expect((await getProposal(p.id))?.notification).toMatchObject({ status: "sent", error: null });
  });

  it("does not complete a dismissal whose settings save failed", async () => {
    const f = fixture(), p = await proposal();
    f.commit.mockResolvedValue(false);
    expect(await decideProposal(p, "dismissed", f.actions)).toBeNull();
    expect(f.complete).not.toHaveBeenCalled();
    expect((await getProposal(p.id))?.status).toBe("pending");
  });

  it("the committed dismissal wins an Apply/Dismiss race and never writes the skill", async () => {
    const f = fixture(), p = await proposal("skill");
    const prepared = { ...await prepareProposal(p.id), epoch: 0 };
    f.replace(applyProposalDecision(f.values(), prepared, "dismissed"));
    expect(() => applyProposalDecision(f.values(), prepared, "accepted")).toThrow("dismissed");
    const results = await Promise.allSettled([dismissProposal(p.id, f.host), acceptProposal(p.id, f.host), dismissProposal(p.id, f.host)]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toBe(`Proposal ${p.id} dismissed by the user.`);
    expect((await readSkill({ id: "weekly" })).missing).toBe(true);
  });

  it("resumes a saved routine decision without creating another routine", async () => {
    const f = fixture(), p = await proposal("routine");
    const prepared = { ...await prepareProposal(p.id), epoch: 0 };
    f.replace(applyProposalDecision(f.values(), prepared, "accepted"));
    const id = f.values().bots[0]!.routines[0]!.id;
    expect((await getProposal(p.id))?.status).toBe("pending");
    await decideProposal(p, "accepted", f.actions);
    expect(f.values().bots[0]!.routines.map((entry) => entry.id)).toEqual([id]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("retries a failed skill write after the settings receipt without announcing false success", async () => {
    const f = fixture(), p = await proposal("skill");
    const path = librarySkillPath("weekly");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "a file blocks this skill folder");
    await expect(decideProposal(p, "accepted", f.actions)).rejects.toThrow("Expected a folder");
    expect(f.values().proposalDecisions).toEqual([{ id: p.id, status: "accepted" }]);
    expect((await getProposal(p.id))?.status).toBe("pending");
    expect(f.send).not.toHaveBeenCalled();
    await rm(path);
    await decideProposal(p, "accepted", f.actions);
    expect(f.values().library?.skills).toHaveLength(1);
    expect((await readSkill({ id: "weekly" })).text).toContain("Report carefully.");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("persists delivery failures and retries the same message identity without applying again", async () => {
    const f = fixture(), p = await proposal();
    f.send.mockRejectedValueOnce(new Error("Host disconnected"));
    const failed = await decideProposal(p, "accepted", f.actions);
    expect(failed?.status).toBe("accepted");
    expect(failed?.notification).toMatchObject({ status: "pending", error: "Host disconnected" });
    const disk = JSON.parse(await readFile(join(pluginDataPath(), "proposals.json"), "utf8")) as { proposals: Proposal[] };
    expect(disk.proposals[0]?.notification).toEqual(failed?.notification);
    // Reopening the card reads persisted state, rather than a component-local retry token.
    await decideProposal((await getProposal(p.id))!, "accepted", f.actions);
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
    expect(f.values().bots).toHaveLength(2);
    expect((await getProposal(p.id))?.notification?.status).toBe("sent");
  });

  it("preserves an uncertain delivery's identity and shows its ambiguity", async () => {
    const f = fixture(), p = await proposal();
    f.send.mockRejectedValue(Object.assign(new Error("unknown"), { code: "agent_request_outcome_unknown" }));
    await decideProposal(p, "accepted", f.actions);
    await acceptProposal(p.id, f.host);
    expect((await getProposal(p.id))?.notification?.error).toContain("delivery could not be confirmed");
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
    expect(f.values().bots).toHaveLength(2);
  });

  it("keeps the pending delivery when saving its acknowledgement fails", async () => {
    const f = fixture(), p = await proposal();
    const delivered = new Set<string>();
    f.send.mockImplementation(async (_text, options) => { delivered.add((options as { messageId: string }).messageId); });
    const write = files.atomicWrite;
    let failed = false;
    vi.spyOn(files, "atomicWrite").mockImplementation(async (path, text) => {
      if (!failed && path.endsWith("proposals.json") && text.includes('"status": "sent"')) {
        failed = true;
        throw new Error("Disk temporarily unavailable");
      }
      return write(path, text);
    });
    await expect(decideProposal(p, "accepted", f.actions)).rejects.toThrow("Disk temporarily unavailable");
    expect((await getProposal(p.id))?.notification?.status).toBe("pending");
    await decideProposal((await getProposal(p.id))!, "accepted", f.actions);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(delivered.size).toBe(1); // Both attempts use Paseo's same durable receipt.
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
    expect((await getProposal(p.id))?.notification?.status).toBe("sent");
    expect(f.values().bots).toHaveLength(2);
  });

  it.each(["deleted", "archived", "another bot"])("keeps the decision applied when the proposing chat is %s", async (state) => {
    const f = fixture(), p = await proposal();
    const snapshot = await f.refresh();
    if (state === "deleted") f.refresh.mockResolvedValue(null as never);
    else if (state === "archived") f.refresh.mockResolvedValue({ agent: { ...snapshot.agent, archivedAt: NOW } });
    else f.refresh.mockResolvedValue({ agent: { ...snapshot.agent, labels: { [BOT_LABEL]: "someone-else" } } });
    const saved = await decideProposal(p, "accepted", f.actions);
    expect(saved?.status).toBe("accepted");
    expect(saved?.notification).toMatchObject({ status: state === "archived" ? "pending" : "unavailable", error: expect.any(String) });
    expect(f.values().bots).toHaveLength(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["running", "initializing", "permission", "active turn"])("defers a notification while the proposer has %s and resumes once idle", async (busy) => {
    const f = fixture(), p = await proposal();
    const idle = await f.refresh();
    f.refresh.mockResolvedValue({ agent: { ...idle.agent, status: busy === "running" || busy === "initializing" ? busy : "idle", pendingPermissions: busy === "permission" ? [{}] : [], activeTurn: busy === "active turn" ? { turnId: "t1" } : null } });
    const saved = await decideProposal(p, "accepted", f.actions);
    expect(saved?.notification).toMatchObject({ status: "waiting", error: null });
    expect(f.send).not.toHaveBeenCalled();
    await retryProposalNotifications(f.host, { waitingOnly: true });
    expect(f.send).not.toHaveBeenCalled();
    f.refresh.mockResolvedValue(idle);
    await retryProposalNotifications(f.host, { waitingOnly: true });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.values().bots).toHaveLength(2);
  });

  it("resumes a committed application on reload, while unavailable settings preserve it untouched", async () => {
    const f = fixture(), p = await proposal("routine");
    f.replace(applyProposalDecision(f.values(), { ...await prepareProposal(p.id), epoch: 0 }, "accepted"));
    const unavailable = new BotsHost({ read: async () => ({ status: "invalid" }) } as never);
    unavailable.attach(f.host.requirePaseo());
    await retryProposalNotifications(unavailable);
    await expect(acceptProposal(p.id, unavailable)).rejects.toThrow("settings are unavailable");
    expect((await getProposal(p.id))?.status).toBe("pending");
    expect(f.send).not.toHaveBeenCalled();
    await retryProposalNotifications(f.host);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.values().bots[0]!.routines).toHaveLength(1);
  });

  it("does not await notification delivery inside lifecycle hooks or retry after cleanup", async () => {
    const f = fixture(), p = await proposal();
    let after: (event: { agent: { id: string } }, context: { paseo: unknown }) => Promise<void>;
    const stop = registerProposalNotifications({ addHook: (_name: string, hook: typeof after) => { after = hook; } } as never, f.host);
    f.send.mockImplementation(async () => {
      await expect(after!({ agent: { id: "original-chat" } }, { paseo: f.host.requirePaseo() })).resolves.toBeUndefined();
    });
    try {
      await decideProposal(p, "accepted", f.actions);
      expect(f.send).toHaveBeenCalledTimes(1);
      await stop();
      await after!({ agent: { id: "original-chat" } }, { paseo: f.host.requirePaseo() });
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally { await stop(); }
  });

  it("waits for in-flight retries during cleanup and stops them before dispatch", async () => {
    const f = fixture(), p = await proposal();
    f.send.mockRejectedValueOnce(new Error("Temporarily offline"));
    await decideProposal(p, "accepted", f.actions);
    const idle = await f.refresh();
    let started!: () => void, release!: (snapshot: typeof idle) => void;
    const checking = new Promise<void>((resolve) => { started = resolve; });
    f.refresh.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const stop = registerProposalNotifications({ addHook: () => {} } as never, f.host);
    await checking;
    const stopping = stop();
    release(idle);
    await stopping;
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await getProposal(p.id))?.notification?.status).toBe("pending");
  });

  it("does not replay historical accepted cards or send retroactive notifications", async () => {
    const f = fixture(), p = await proposal();
    const historical = { ...p, status: "accepted", resolvedAt: NOW };
    await writeFile(join(pluginDataPath(), "proposals.json"), JSON.stringify({ proposals: [historical] }));
    await decideProposal(p, "accepted", f.actions);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.values().bots).toHaveLength(1);
  });

  it.each(["sent", "unavailable"] as const)("retires %s cards, retains pending delivery, and invalidates delayed applications after receipt pruning", async (status) => {
    const f = fixture(), p = await proposal();
    const pendingDelivery: Proposal = { ...p, id: "p-delivery", status: "accepted", resolvedAt: NOW, notification: { status: "pending", text: "Saved", error: "offline" } };
    const retired: Proposal = { ...p, id: "p-retired", status: "accepted", resolvedAt: NOW, notification: { status, text: "Saved", error: null } };
    const pending = Array.from({ length: 198 }, (_, index) => ({ ...p, id: `p-pending${index}` }));
    await writeFile(join(pluginDataPath(), "proposals.json"), JSON.stringify({ proposals: [pendingDelivery, retired, ...pending] }));
    f.replace({ ...f.values(), proposalDecisions: [{ id: retired.id, status: "accepted" }] });
    const newProposal = await proposal("routine");
    expect(await getProposal(pendingDelivery.id)).toEqual(pendingDelivery);
    expect(await getProposal(retired.id)).toBeNull();
    const prepared = { ...await prepareProposal(newProposal.id, [retired.id]), epoch: 0 };
    expect(prepared.expiredReceiptIds).toEqual([retired.id]);
    f.replace(applyProposalDecision(f.values(), prepared, "accepted"));
    expect(f.values().proposalDecisionEpoch).toBe(1);
    // A browser that prepared the retired card before it was applied cannot apply it again.
    const stale = { proposal: { ...retired, status: "pending" as const }, epoch: 0, expiredReceiptIds: [] };
    expect(() => applyProposalDecision(f.values(), stale, "accepted")).toThrow("changed while saving");
    await expect(proposal()).rejects.toThrow("200 pending cards");
    expect((await getProposal(pendingDelivery.id))?.notification?.status).toBe("pending");
  });

  it("keeps old proposal records and settings documents compatible", async () => {
    const p = await proposal();
    expect(ProposalSchema.parse(p).notification).toBeUndefined();
    const missing = fixture();
    missing.replace({ bots: [], history: [] });
    const routine = await proposal("routine");
    await expect(decideProposal(routine, "accepted", missing.actions)).rejects.toThrow("no longer exists");
    expect(missing.send).not.toHaveBeenCalled();
  });
});
