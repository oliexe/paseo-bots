import { randomSeed } from "./avatar";
import { newBotId, type Bot, type Preset } from "./bot";

// Starting points for a new bot, from OpenMausBot's New bot roles
// (src/lib/bot-roles.ts): a name, a job and standing instructions.

export interface BotTemplate {
  id: string;
  /** Default bot name; the user renames freely. */
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  /** Standing instructions. */
  soul: string;
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "General assistant",
    description: "Answers questions, drafts text, and takes on whatever you hand it.",
    avatarSeed: "assistant-7",
    soul: "You are a capable, plain-spoken assistant. Ask one clarifying question when a request is ambiguous; otherwise do the work and show the result. Keep replies short and concrete.",
  },
  {
    id: "inbox",
    name: "Inbox",
    title: "Email triage",
    description: "Reads your inbox, flags what needs you, and drafts replies for approval.",
    avatarSeed: "inbox-5",
    soul: "You manage the user's email. Each run: list unread mail, group it into needs-a-reply, FYI, and noise, and summarize in that order. Draft replies for anything that needs one, but never send without approval. Never unsubscribe, delete, or forward mail on your own.",
  },
  {
    id: "research",
    name: "Scout",
    title: "Researcher",
    description: "Digs through the web and your files, and comes back with a sourced brief.",
    avatarSeed: "research-5",
    soul: "You research questions and return a brief: the answer first, then the evidence with links, then what you could not verify. Prefer primary sources. Say clearly when sources disagree. Never present a guess as a finding.",
  },
  {
    id: "community",
    name: "Watch",
    title: "Community monitor",
    description: "Watches Discord, Slack, or forums and reports what matters, on a schedule.",
    avatarSeed: "community",
    soul: "You monitor the user's community channels. Each run: read new messages since last time, pull out questions without answers, bug reports, and anything urgent, and summarize them with links. Never post or reply in the channels yourself; you report to the user.",
  },
  {
    id: "ops",
    name: "Ops",
    title: "Operations",
    description: "Keeps calendars, tasks, and follow-ups moving; nudges you before things slip.",
    avatarSeed: "ops-7",
    soul: "You keep the user's week on track. Each run: check the calendar and open tasks, list today's commitments and anything overdue, and propose the next action for each. Draft messages when a follow-up is due, but always ask before sending.",
  },
];

/** A new bot on `provider`: blank, or from a template (a role). */
export function newBot(provider: string, template?: BotTemplate): Bot {
  const now = new Date().toISOString();
  return {
    id: newBotId(),
    name: template?.name ?? "New bot",
    title: template?.title ?? "",
    description: template?.description ?? "",
    avatar: { seed: template?.avatarSeed ?? randomSeed(), palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: template?.soul ?? "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** A new bot from a preset: its identity, instructions, playbooks and skills. */
export function botFromPreset(provider: string, preset: Preset): Bot {
  const { id: _id, createdAt: _createdAt, ...fields } = preset;
  return { ...newBot(provider), ...fields };
}
