import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalSchema, type Proposal } from "../shared/proposals";
import { pluginDataPath } from "./bot-home";
import { writeSkill } from "./library";
import { atomicWrite, missingFile } from "./files";

// Proposals wait in one file until the user saves or dismisses their card.
// Only the newest are kept; an older card says it's no longer available.

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
    await atomicWrite(storePath(), JSON.stringify({ proposals: proposals.slice(-KEEP) }, null, 2));
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

export function createProposal(input: NewProposal): Promise<Proposal> {
  const proposal = { ...input, id: `p-${randomBytes(5).toString("hex")}`, status: "pending", createdAt: new Date().toISOString(), resolvedAt: null } as Proposal;
  return update((proposals) => ({ proposals: [...proposals, proposal], result: proposal }));
}

export async function getProposal(id: string): Promise<Proposal | null> {
  return (await load()).find((proposal) => proposal.id === id) ?? null;
}

function resolve(id: string, status: "accepted" | "dismissed"): Promise<Proposal> {
  return update((proposals) => {
    const current = proposals.find((proposal) => proposal.id === id);
    if (!current) throw new Error("This proposal is no longer available.");
    if (current.status !== "pending") throw new Error(current.status === "accepted" ? "It's already saved." : "It was dismissed.");
    const resolved = { ...current, status, resolvedAt: new Date().toISOString() };
    return { proposals: proposals.map((proposal) => (proposal.id === id ? resolved : proposal)), result: resolved };
  });
}

export function dismissProposal(id: string): Promise<Proposal> {
  return resolve(id, "dismissed");
}

/** Saves what the proposal describes on this host; the app then records it in the bots' settings. */
export async function acceptProposal(id: string) {
  return update(async (proposals) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (!proposal) throw new Error("This proposal is no longer available.");
    if (proposal.status !== "pending") throw new Error(proposal.status === "accepted" ? "It's already saved." : "It was dismissed.");
    const saved = proposal.kind === "skill" ? await writeSkill({ id: proposal.data.name, text: proposal.data.text }) : null;
    const accepted: Proposal = { ...proposal, status: "accepted", resolvedAt: new Date().toISOString() };
    const skill = saved && proposal.kind === "skill" ? { id: proposal.data.name, description: saved.description, sha: saved.sha } : undefined;
    return { proposals: proposals.map((item) => item.id === id ? accepted : item), result: { proposal: accepted, ...(skill ? { skill } : {}) } };
  });
}
