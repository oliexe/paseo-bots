import { z } from "zod";
import { InteractionSpecSchema } from "../../shared/interaction";
import { interactions } from "../interactions";
import { defineTool } from "./mcp";

export const showCard = defineTool({
  name: "show_card",
  description: "Show an interactive card in this chat: confirm an action with a preview, choose one or several options, fill a small form, or review and edit a draft. The user's answer comes as a new message in this same chat. This tool only presents the card; it does not perform the proposed action. Finish your turn and wait for the answer. Never request passwords, tokens or other secrets in a card.",
  input: z.object({
    key: z.string().min(1).max(100).optional().describe("A unique key for this request. Repeating the same key and card is safe if a tool response was lost."),
    card: InteractionSpecSchema,
  }),
  async run({ key, card }, { bot, agentId, host }) {
    const saved = await interactions.create({ botId: bot.id, agentId, spec: card, key }, host.requirePaseo());
    return JSON.stringify({ cardId: saved.id, status: saved.status, instruction: saved.status === "pending" ? "The card is visible in the chat. Finish your turn and wait for the user to answer it. Do not perform its proposed action before that answer." : "This card already exists. Do not create a duplicate.", ...(saved.response ? { response: saved.response } : {}) });
  },
});
