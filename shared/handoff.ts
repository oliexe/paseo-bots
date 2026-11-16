import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ASKED_BY_LABEL = "paseo-bots.asked-by";
export const ASKED_IN_LABEL = "paseo-bots.asked-in";

export const HandoffStatusSchema = z.object({
  state: z.enum(["running", "permission", "error", "finished", "archived"]),
  reply: z.string().max(6000),
  error: z.string().max(1000).nullable(),
});
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
export const HandoffCardSchema = z.object({
  requesterBotId: z.string().min(1).max(200),
  requesterAgentId: z.string().min(1).max(200),
  targetBotId: z.string().min(1).max(200),
  targetAgentId: z.string().min(1).max(200),
  targetName: z.string().min(1).max(200),
  request: z.string().max(600),
  createdAt: z.string(),
  status: HandoffStatusSchema,
});
export type HandoffCard = z.infer<typeof HandoffCardSchema>;
export const HANDOFF_CARD = { kind: "bot-handoff", version: 1 } as const;

export const handoffStatusRpc = defineRpc({
  name: "bots.handoffs.status",
  input: z.object({ requesterAgentId: z.string().min(1).max(200), targetAgentId: z.string().min(1).max(200) }).strict(),
  output: z.object({ status: HandoffStatusSchema.nullable() }),
});

export function handoffSearchText(card: HandoffCard): string {
  return [card.targetName, card.request, card.status.reply, card.status.error ?? ""].join("\n");
}
