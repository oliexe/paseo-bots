import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BOT_LABEL } from "../shared/bot";
import { ProposalSchema, type Proposal, type ProposalDecision } from "../shared/proposals";
import { parseSkillFrontmatter } from "../shared/skills";
import { pluginDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import { librarySkillPath, sha256, writeSkill } from "./library";
import { atomicWrite, missingFile } from "./files";

// Proposals wait in one file until the user saves or dismisses their card.
// Only delivered decisions can be retired; pending applications and deliveries survive.

const KEEP = 200;

type NewProposal = Pick<Proposal, "botId" | "agentId" | "kind" | "data">;

function storePath(): string {
  return join(pluginDataPath(), "proposals.json");
}

async function load(): Promise<Proposal[]> {
  try {
    const saved = JSON.parse(await readFile(storePath(), "utf8")) as { proposals?: unknown };
    return ProposalSchema.array().parse(saved.proposals);
  } catch (error) {
    if (missingFile(error)) return [];
    throw new Error("Couldn't read saved proposals. The existing file was kept intact.", { cause: error });
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One read-modify-write at a time. */
function update<T>(change: (proposals: Proposal[]) => { proposals: Proposal[]; result: T } | Promise<{ proposals: Proposal[]; result: T }>): Promise<T> {
  const run = async () => {
    const { proposals, result } = await change(await load());
    await atomicWrite(storePath(), JSON.stringify({ proposals }, null, 2));
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

export function createProposal(input: NewProposal): Promise<Proposal> {
  const proposal = { ...input, id: `p-${randomBytes(5).toString("hex")}`, status: "pending", createdAt: new Date().toISOString(), resolvedAt: null } as Proposal;
  return update((proposals) => {
    const retained = [...proposals];
    while (retained.length >= KEEP) {
      const index = retained.findIndex((entry) => entry.status !== "pending" && (!entry.notification || entry.notification.status === "sent" || entry.notification.status === "unavailable"));
      if (index < 0) throw new Error("Finish or dismiss existing proposals before creating another (200 pending cards).");
      retained.splice(index, 1);
    }
    return { proposals: [...retained, proposal], result: proposal };
  });
}

export async function getProposal(id: string): Promise<Proposal | null> {
  return (await load()).find((proposal) => proposal.id === id) ?? null;
}

/** Preparing a skill never writes its file or marks the proposal accepted. */
export async function prepareProposal(id: string, receiptIds: readonly string[] = []) {
  const proposals = await load();
  const proposal = proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error("This proposal is no longer available.");
  let skill;
  if (proposal.kind === "skill" && proposal.status === "pending") {
    librarySkillPath(proposal.data.name);
    if (Buffer.byteLength(proposal.data.text, "utf8") > 512 * 1024) throw new Error("A skill file must be at most 512 KB.");
    skill = { id: proposal.data.name, description: parseSkillFrontmatter(proposal.data.text).description ?? "", sha: sha256(proposal.data.text) };
  }
  return { proposal, ...(skill ? { skill } : {}), expiredReceiptIds: receiptIds.filter((receiptId) => !proposals.some((entry) => entry.id === receiptId)) };
}

function decisionText(proposal: Proposal, status: ProposalDecision): string {
  if (status === "dismissed") return `Proposal ${proposal.id} dismissed by the user.`;
  const detail = proposal.kind === "changes" ? `${proposal.data.changes.length} ${proposal.data.changes.length === 1 ? "change" : "changes"}` : proposal.kind === "skill" ? "skill saved and enabled" : "routine created";
  return `Proposal ${proposal.id} applied by the user (${detail}).`;
}

const deliveries = new Map<string, Promise<Proposal>>();

/** The settings receipt is authoritative; a failed settings save cannot announce success. */
function completeProposal(id: string, status: ProposalDecision, host: BotsHost, stopped?: () => boolean): Promise<Proposal> {
  const key = `${storePath()}:${id}`;
  const previous = deliveries.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    let proposal = await update(async (proposals) => {
      const current = proposals.find((candidate) => candidate.id === id);
      if (!current) throw new Error("This proposal is no longer available.");
      if (current.status !== "pending") {
        if (current.status !== status) throw new Error(current.status === "accepted" ? "It's already saved." : "It was dismissed.");
        return { proposals, result: current };
      }
      const values = await host.values();
      if (!values) throw new Error("Bot settings are unavailable. Retry when they have loaded.");
      const receipt = values.proposalDecisions?.find((entry) => entry.id === id);
      if (receipt?.status !== status) throw new Error("The proposal decision has not been saved to settings. Try again from its card.");
      if (status === "accepted" && current.kind === "skill") await writeSkill({ id: current.data.name, text: current.data.text });
      const resolved: Proposal = { ...current, status, resolvedAt: new Date().toISOString(), notification: { status: "pending", text: decisionText(current, status), error: null } };
      return { proposals: proposals.map((entry) => entry.id === id ? resolved : entry), result: resolved };
    });
    // Historical decisions have no notification, and successful retries are no-ops.
    if (!proposal.notification || proposal.notification.status === "sent" || proposal.notification.status === "unavailable") return proposal;
    if (stopped?.()) return proposal;
    let error: string | null = null;
    let waiting = false;
    let unavailable = false;
    try {
      const agent = host.requirePaseo().agents.ref(proposal.agentId);
      const snapshot = await agent.refresh();
      if (stopped?.()) return proposal;
      if (!snapshot || snapshot.agent.labels?.[BOT_LABEL] !== proposal.botId) {
        unavailable = true;
        throw new Error("The proposing chat is no longer available. The decision was saved.");
      }
      if (snapshot.agent.archivedAt) throw new Error("The proposing chat is archived. Restore it before retrying the notification.");
      waiting = snapshot.agent.status === "running" || snapshot.agent.status === "initializing" || !!snapshot.agent.activeTurn || !!snapshot.agent.pendingPermissions?.length;
      // On providers without steering, Paseo can replace an active turn. Wait instead;
      // the public SDK has no atomic "send only if idle" operation.
      if (!waiting) await agent.send(proposal.notification.text, { messageId: `bots-proposal-${proposal.id}`, activeTurnBehavior: "steer" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = (cause as { code?: string } | null)?.code;
      error = code === "agent_request_outcome_unknown" || message.includes("agent_request_outcome_unknown")
        ? "Paseo received the decision, but delivery could not be confirmed. Check the chat before taking further action."
        : message.slice(0, 2000);
    }
    proposal = await update((proposals) => {
      const current = proposals.find((entry) => entry.id === id)!;
      const saved: Proposal = { ...current, notification: { ...proposal.notification!, status: unavailable ? "unavailable" : waiting ? "waiting" : error ? "pending" : "sent", error } };
      return { proposals: proposals.map((entry) => entry.id === id ? saved : entry), result: saved };
    });
    return proposal;
  });
  deliveries.set(key, next);
  void next.finally(() => { if (deliveries.get(key) === next) deliveries.delete(key); }).catch(() => {});
  return next;
}

export function dismissProposal(id: string, host: BotsHost): Promise<Proposal> {
  return completeProposal(id, "dismissed", host);
}

export async function acceptProposal(id: string, host: BotsHost): Promise<{ proposal: Proposal }> {
  return { proposal: await completeProposal(id, "accepted", host) };
}

/** Resume durable work after reconnect/reload; polling only retries busy-chat deferrals. */
export async function retryProposalNotifications(host: BotsHost, options: { waitingOnly?: boolean; agentId?: string; stopped?: () => boolean } = {}): Promise<void> {
  if (!host.paseo || options.stopped?.()) return;
  const values = await host.values();
  if (!values) return; // Invalid/unavailable settings are not deleted settings.
  for (const proposal of await load()) {
    if (options.stopped?.()) return;
    if (options.agentId && proposal.agentId !== options.agentId) continue;
    if (options.waitingOnly && proposal.notification?.status !== "waiting") continue;
    const status = proposal.status === "pending" ? values.proposalDecisions?.find((entry) => entry.id === proposal.id)?.status : proposal.notification && (proposal.notification.status === "pending" || proposal.notification.status === "waiting") ? proposal.status : null;
    if (status) await completeProposal(proposal.id, status, host, options.stopped).catch((error: unknown) => console.error("paseo-bots: couldn't finish a proposal decision", error));
  }
}

export function registerProposalNotifications(server: PluginServerContext, host: BotsHost): () => Promise<void> {
  let stopped = false;
  let polling = false;
  const tasks = new Set<Promise<void>>();
  const retry = (options: { waitingOnly?: boolean; agentId?: string } = {}) => {
    // send() invokes lifecycle hooks; never await delivery from inside such a hook.
    if (stopped) return Promise.resolve();
    const task = retryProposalNotifications(host, { ...options, stopped: () => stopped })
      .catch((error: unknown) => console.error("paseo-bots: couldn't retry proposal notifications", error));
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  };
  const detach = host.onAttach(() => { void retry(); });
  server.addHook("agent.turn.after", async ({ agent }, context) => { host.attach(context.paseo); void retry({ agentId: agent.id }); });
  const timer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    void retry({ waitingOnly: true }).finally(() => { polling = false; });
  }, 5000);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); detach(); await Promise.allSettled([...tasks]); };
}
