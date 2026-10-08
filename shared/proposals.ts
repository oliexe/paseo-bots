import { z } from "zod";
import { RoutineScheduleSchema } from "./bot";
import { botToolName } from "./bot-tools";
import { ChangeSchema } from "./changes";
import { toolCallName } from "./tool-name";

// What a bot proposes in a chat (a skill it learned, a routine, changes to the
// setup) waits as a card in that chat and is saved only when the user accepts it.

const ProposalBase = z.object({
  id: z.string(),
  botId: z.string(),
  /** The chat the proposal came from. */
  agentId: z.string(),
  status: z.enum(["pending", "accepted", "dismissed"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

/** A new or updated library skill: its folder name and full SKILL.md. */
const SkillProposalSchema = z.object({ name: z.string(), description: z.string(), text: z.string() });

/** A new routine for the bot; its runs report back to the chat it was proposed in. */
const RoutineProposalSchema = z.object({ name: z.string(), prompt: z.string(), schedule: RoutineScheduleSchema, resultsChatId: z.string().nullable() });

/** Changes to the setup, applied together (shared/changes.ts); `provider` is the host's pick for new bots the defaults leave open. */
const ChangesProposalSchema = z.object({ summary: z.string(), changes: z.array(ChangeSchema), provider: z.string().default("") });

export const ProposalSchema = z.discriminatedUnion("kind", [
  ProposalBase.extend({ kind: z.literal("skill"), data: SkillProposalSchema }),
  ProposalBase.extend({ kind: z.literal("routine"), data: RoutineProposalSchema }),
  ProposalBase.extend({ kind: z.literal("changes"), data: ChangesProposalSchema }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

const PROPOSAL_ID = /\bproposal (p-[a-z0-9]{10})\b/i;

/** What a propose_* tool tells the agent; the card finds the proposal from it. */
export function proposalReply(id: string, what: string): string {
  return `Proposal ${id}: the user sees ${what} as a card in this chat and decides whether to save it. Don't save it yourself.`;
}

/** The proposal a propose_* tool call made, from its output (text or MCP content blocks). */
function proposalIdIn(output: unknown): string | null {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return PROPOSAL_ID.exec(text)?.[1] ?? null;
}

const PROPOSING_TOOLS: readonly string[] = ["propose_skill", "propose_routine", "propose_changes"];

/** The proposal behind a finished propose_* tool call, if the call is one. */
export function proposalIdOf(call: { name: string; status: string; detail: unknown; metadata?: unknown }): string | null {
  const tool = botToolName(toolCallName(call));
  if (call.status !== "completed" || !tool || !PROPOSING_TOOLS.includes(tool)) return null;
  const detail = call.detail as { output?: unknown } | null;
  return proposalIdIn(detail && typeof detail === "object" && "output" in detail ? detail.output : null);
}
