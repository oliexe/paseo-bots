import { EMPTY_LIBRARY, newRoutineId, type BotSettingsValues } from "./bot";
import { applyChanges } from "./changes";
import { setBotUses, updateSkill, upsertSkills } from "./library";
import type { Proposal, ProposalDecision, ProposalSkill } from "./proposals";

export interface PreparedProposalDecision {
  proposal: Proposal;
  skill?: ProposalSkill;
  expiredReceiptIds: string[];
  epoch: number;
}

/** The decision and its settings changes share one compare-and-swap write. */
export function applyProposalDecision(current: BotSettingsValues, prepared: PreparedProposalDecision, status: ProposalDecision, now = new Date().toISOString()): BotSettingsValues {
  const { proposal, skill } = prepared;
  const receipts = current.proposalDecisions ?? [];
  const existing = receipts.find((entry) => entry.id === proposal.id);
  if (existing) {
    if (existing.status !== status) throw new Error(existing.status === "accepted" ? "This proposal was already applied." : "This proposal was dismissed.");
    return current;
  }
  if (proposal.status !== "pending") throw new Error("This proposal was already decided. Refresh its card.");
  if ((current.proposalDecisionEpoch ?? 0) !== prepared.epoch) throw new Error("Proposal decisions changed while saving. Try again.");
  const retained = receipts.filter((entry) => !prepared.expiredReceiptIds.includes(entry.id));
  if (retained.length >= 200) throw new Error("Finish the pending proposal decisions before saving another.");

  let values = current;
  if (status === "accepted") {
    if (proposal.kind === "changes") {
      values = applyChanges(current, proposal.data.changes, { now, provider: proposal.data.provider });
    } else {
      const bot = current.bots.find((entry) => entry.id === proposal.botId);
      if (!bot) throw new Error("The bot that proposed this no longer exists.");
      if (proposal.kind === "routine") {
        const routine = { id: newRoutineId(), ...proposal.data, enabled: true, createdAt: now };
        values = { ...current, bots: current.bots.map((entry) => entry.id === bot.id ? { ...entry, routines: [...entry.routines, routine] } : entry) };
      } else {
        if (!skill || skill.id !== proposal.data.name) throw new Error("Prepare the skill again before saving it.");
        values = {
          ...current,
          library: updateSkill(upsertSkills(current.library ?? EMPTY_LIBRARY, [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }]), skill.id, { enabled: true }),
          bots: current.bots.map((entry) => entry.id === bot.id ? setBotUses(entry, "skill", skill.id, true) : entry),
        };
      }
    }
  }
  return {
    ...values,
    proposalDecisions: [...retained, { id: proposal.id, status }],
    proposalDecisionEpoch: prepared.epoch + (retained.length < receipts.length ? 1 : 0),
  };
}
