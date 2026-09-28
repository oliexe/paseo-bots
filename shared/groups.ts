import type { Bot, BotGroup, TeamLogo } from "./bot";

// OpenMausBot's teams: a bot belongs to at most one team, every member gets the
// team's roster and shared instructions in its prompt, and the team's Chief of
// Staff (its lead) is the user's main contact who hands work to the others.

const ROSTER_MAX = 40;

/** The team's logo; teams from before logos draw one from their id. */
export function teamLogoOf(group: Pick<BotGroup, "id" | "logo">): TeamLogo {
  return group.logo ?? { seed: group.id, palette: null, imageUrl: null };
}

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
  logo: TeamLogo | null;
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

// ------------------------------------------------------------------ tabs

/** The tab of the bots that aren't on a team. */
export const OTHER_BOTS_TAB = "other";

export interface TeamTab {
  /** A team id, or OTHER_BOTS_TAB. */
  id: string;
  group: BotGroup | null;
  /** The listed bots on it; a team's lead comes first. */
  bots: Bot[];
}

/**
 * With teams the bot list splits into tabs: one per team, then "Other bots"
 * when some listed bots have no team. Without teams there are none.
 */
export function teamTabs(groups: readonly BotGroup[], bots: readonly Bot[]): TeamTab[] {
  if (groups.length === 0) return [];
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const teamed = new Set<string>();
  const tabs: TeamTab[] = groups.map((group) => {
    const ids = [...(group.leadId ? [group.leadId] : []), ...group.memberIds.filter((id) => id !== group.leadId)];
    for (const id of ids) teamed.add(id);
    return { id: group.id, group, bots: ids.flatMap((id) => byId.get(id) ?? []) };
  });
  const others = bots.filter((bot) => !teamed.has(bot.id));
  return others.length > 0 ? [...tabs, { id: OTHER_BOTS_TAB, group: null, bots: others }] : tabs;
}

/** The tab a bot is listed under. */
export function tabOf(botId: string, groups: readonly BotGroup[]): string {
  return teamOf(botId, groups)?.id ?? OTHER_BOTS_TAB;
}
