import { z } from "zod";
import type { RoutineSchedule } from "../../shared/bot";
import { proposalReply } from "../../shared/proposals";
import { describeSchedule, parseLocalDateTime, upcomingRuns, validateCron } from "../../shared/routines";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

// OpenMausBot's propose_routine: the bot suggests a routine, the user confirms
// it on a card in the chat, and the runs report back to that chat.

const ScheduleInput = z.object({
  type: z.enum(["once", "daily", "cron", "interval", "webhook"]),
  at: z.string().max(40).optional().describe('For "once": local date and time, "YYYY-MM-DD HH:MM".'),
  time: z.string().max(5).optional().describe('For "daily": local time, "HH:MM".'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('For "daily": the days to run, 0 = Sunday to 6 = Saturday. Every day when left out.'),
  expression: z.string().max(100).optional().describe('For "cron": five fields (minute hour day-of-month month day-of-week) in local time.'),
  every_minutes: z.number().int().min(5).max(1440).optional().describe('For "interval": minutes between runs, 5 to 1440.'),
});

/** The routine schedule a tool call describes; throws a message the bot can act on. */
export function scheduleFrom(input: z.infer<typeof ScheduleInput>, now: Date): RoutineSchedule {
  switch (input.type) {
    case "once": {
      const at = input.at ? (parseLocalDateTime(input.at) ?? new Date(input.at)) : null;
      if (!at || Number.isNaN(at.getTime())) throw new Error('A "once" routine needs "at" as "YYYY-MM-DD HH:MM".');
      if (at <= now) throw new Error(`${input.at} has already passed. Pick a time in the future.`);
      return { kind: "once", at: at.toISOString() };
    }
    case "daily": {
      if (!input.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('A "daily" routine needs "time" as "HH:MM".');
      const weekdays = [...new Set(input.weekdays ?? [0, 1, 2, 3, 4, 5, 6])].sort();
      if (weekdays.length === 0) throw new Error("Give at least one weekday.");
      return { kind: "daily", time: input.time, weekdays };
    }
    case "cron": {
      const error = validateCron(input.expression ?? "");
      if (error) throw new Error(`${error}. Use five fields: minute hour day-of-month month day-of-week.`);
      return { kind: "cron", expression: input.expression!.trim() };
    }
    case "interval":
      if (!input.every_minutes) throw new Error('An "interval" routine needs "every_minutes" (5 to 1440).');
      return { kind: "interval", minutes: input.every_minutes };
    case "webhook":
      return { kind: "webhook" };
  }
}

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
