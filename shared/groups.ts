import type { Bot, BotGroup } from "./bot";

// OpenMausBot's teams: a bot belongs to at most one team, every member gets the
// team's roster and shared instructions in its prompt, and the team's Chief of
// Staff (its lead) is the user's main contact who hands work to the others.

const ROSTER_MAX = 40;

/** The team a bot is on, if any. */
export function teamOf(botId: string, groups: readonly BotGroup[]): BotGroup | null {
  return groups.find((group) => group.leadId === botId || group.memberIds.includes(botId)) ?? null;
}

/** The team's bots that still exist, lead first. */
export function groupBots(group: BotGroup, bots: readonly Bot[]): { lead: Bot | null; members: Bot[] } {
  const live = (id: string) => bots.find((bot) => bot.id === id && !bot.archived) ?? null;
  const lead = group.leadId ? live(group.leadId) : null;
  const members = group.memberIds.filter((id) => id !== group.leadId).map(live).filter((bot): bot is Bot => bot !== null);
  return { lead, members };
}

function rosterLine(bot: Bot, lead: boolean): string {
  const about = [bot.title, bot.description].filter((part) => part.trim()).join(" — ");
  return `- ${bot.name}${lead ? " (Chief of Staff)" : ""}${about ? `: ${about}` : ""}`;
}

/** A team member's prompt section: its teammates, the shared instructions and, for the lead, how to lead. */
export function teamPrompt(group: BotGroup, bot: Bot, bots: readonly Bot[]): string {
  const { lead, members } = groupBots(group, bots);
  const isLead = lead?.id === bot.id;
  const others = [...(lead && !isLead ? [lead] : []), ...members.filter((member) => member.id !== bot.id)].slice(0, ROSTER_MAX);
  const name = group.name.trim() || "Untitled";
  const parts = [
    isLead
      ? `You are the Chief of Staff of the "${name}" team and the user's main contact for it. Own the outcome: understand the request, decide what to handle yourself, hand parts to the teammates who fit them with ask_bot when that helps, and return one concise answer. Don't delegate trivial work to look busy, and never invent a teammate's progress or result.`
      : `You're on the "${name}" team.${lead ? ` ${lead.name} leads it.` : ""}`,
    others.length ? `Teammates:\n${others.map((other) => rosterLine(other, other.id === lead?.id)).join("\n")}` : "",
    group.instructions.trim() ? `Shared instructions for the team. The user manages them for every bot on the team; you can't edit them.\n${group.instructions.trim()}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

export interface TeamDraft {
  name: string;
  leadId: string | null;
  memberIds: string[];
  instructions: string;
}

/** Creates (null id) or updates a team; its members leave any other team they were on. */
export function saveTeam(groups: readonly BotGroup[], id: string | null, draft: TeamDraft, newId: string, now: string): BotGroup[] {
  const teamId = id ?? newId;
  const joining = new Set(draft.memberIds);
  const existing = groups.find((group) => group.id === teamId);
  const team: BotGroup = { id: teamId, ...draft, leadId: draft.leadId && joining.has(draft.leadId) ? draft.leadId : null, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const others = groups.map((group) => {
    if (group.id === teamId) return team;
    const memberIds = group.memberIds.filter((member) => !joining.has(member));
    const leadId = group.leadId && joining.has(group.leadId) ? null : group.leadId;
    return memberIds.length === group.memberIds.length && leadId === group.leadId ? group : { ...group, memberIds, leadId, updatedAt: now };
  });
  return existing ? others : [...others, team];
}

/** Takes a deleted bot off its team. */
export function withoutBot(groups: readonly BotGroup[], botId: string, now: string): BotGroup[] {
  return groups.map((group) =>
    group.memberIds.includes(botId) || group.leadId === botId ? { ...group, memberIds: group.memberIds.filter((id) => id !== botId), leadId: group.leadId === botId ? null : group.leadId, updatedAt: now } : group,
  );
}
