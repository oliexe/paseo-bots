import type { BotSettingsValues } from "../../shared/bot";
import { applyProposalDecision } from "../../shared/proposal-decisions";
import type { Proposal, ProposalDecision, ProposalSkill } from "../../shared/proposals";

interface DecisionActions {
  values(): BotSettingsValues | null;
  prepare(input: { id: string; receiptIds: string[] }): Promise<{ proposal: Proposal; skill?: ProposalSkill; expiredReceiptIds: string[] }>;
  commit(mutate: (values: BotSettingsValues) => BotSettingsValues): Promise<boolean>;
  complete(id: string, status: ProposalDecision): Promise<Proposal>;
}

/** Completion never runs after an unsuccessful settings save. Safe to resume after reopening. */
export async function decideProposal(proposal: Proposal, status: ProposalDecision, actions: DecisionActions): Promise<Proposal | null> {
  if (proposal.status === "pending") {
    const values = actions.values();
    if (!values) return null;
    const epoch = values.proposalDecisionEpoch ?? 0;
    const prepared = await actions.prepare({ id: proposal.id, receiptIds: (values.proposalDecisions ?? []).map((entry) => entry.id) });
    if (prepared.proposal.status !== "pending") {
      if (prepared.proposal.status !== status) throw new Error(prepared.proposal.status === "accepted" ? "This proposal was already applied." : "This proposal was dismissed.");
    } else if (!(await actions.commit((current) => applyProposalDecision(current, { ...prepared, epoch }, status)))) return null;
  }
  return actions.complete(proposal.id, status);
}
