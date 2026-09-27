import { BotsHost } from "../server/host";
import { EMPTY_LIBRARY, type Bot, type BotSettingsValues, type Library } from "../shared/bot";

export const NOW = "2026-09-27T00:00:00.000Z";

export function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Inbox",
    title: "",
    description: "",
    avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
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
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

/** A host over in-memory settings; `values` can be mutated between calls. */
export function fakeHost(bots: Bot[], library: Library = EMPTY_LIBRARY): BotsHost & { values(): Promise<BotSettingsValues> } {
  const values: BotSettingsValues = { bots, history: [], library };
  const settings = { read: async () => ({ status: "ready" as const, values, revision: "1" }) };
  return new BotsHost(settings as never) as BotsHost & { values(): Promise<BotSettingsValues> };
}
