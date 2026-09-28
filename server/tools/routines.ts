import { z } from "zod";
import { proposalReply } from "../../shared/proposals";
import { describeSchedule, ScheduleInput, scheduleFrom, upcomingRuns } from "../../shared/routines";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

// OpenMausBot's propose_routine: the bot suggests a routine, the user confirms
// it on a card in the chat, and the runs report back to that chat.

export const proposeRoutine = defineTool({
  name: "propose_routine",
  description:
    "Propose a routine: instructions you'll carry out on a schedule (or when a webhook is called), each run in its own new chat. The user confirms it on a card in this chat, and each run's result is posted back here. Times are in this computer's local time.",
  input: z.object({
    name: z.string().min(1).max(80).describe('A short name, like "Morning inbox check".'),
    instructions: z.string().min(1).max(20_000).describe("What to do on each run, written so it works without this chat."),
    schedule: ScheduleInput,
  }),
  async run({ name, instructions, schedule }, { bot, agentId }) {
    const now = new Date();
    const parsed = scheduleFrom(schedule, now);
    const proposal = await createProposal({ botId: bot.id, agentId, kind: "routine", data: { name: name.trim(), prompt: instructions.trim(), schedule: parsed, resultsChatId: agentId } });
    const next = upcomingRuns(parsed, now, now, 1)[0];
    const when = parsed.kind === "webhook" ? "It runs when its webhook is called; the URL is in the routine's settings." : `${describeSchedule(parsed)}${next ? `, first on ${next.toLocaleString()}` : ""}.`;
    return `${proposalReply(proposal.id, `the routine "${name.trim()}"`)} ${when}`;
  },
});
