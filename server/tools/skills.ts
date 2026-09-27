import { z } from "zod";
import { proposalReply } from "../../shared/proposals";
import { sanitizeSkillName, skillMarkdown } from "../../shared/skills";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

// /learn: the bot turns what it just did into a skill; the user saves it from a card.

export const proposeSkill = defineTool({
  name: "propose_skill",
  description:
    "Propose a reusable skill from work you just did, for the user to review and save to your skills. Use it when the user asks you to learn or remember how to do something. Proposing a name you already use updates that skill.",
  input: z.object({
    name: z.string().min(1).max(64).describe('Short, lowercase and dashed, like "weekly-report".'),
    description: z.string().min(1).max(300).describe("One line saying when to use the skill. Bots decide from this line."),
    instructions: z.string().min(1).max(50_000).describe("Markdown: the steps, what to check, and what the result looks like. Write it so it works next time without this chat."),
  }),
  async run({ name, description, instructions }, { bot, agentId }) {
    const id = sanitizeSkillName(name);
    const proposal = await createProposal({ botId: bot.id, agentId, kind: "skill", data: { name: id, description: description.replace(/\s+/g, " ").trim(), text: skillMarkdown(id, description, instructions) } });
    return proposalReply(proposal.id, `the skill "${id}"`);
  },
});
