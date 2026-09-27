import { joinArgs, RESERVED_MCP_NAMES, uniqueName, type Bot, type BotMcpServer, type Library, type LibraryMcpServer, type LibrarySkill } from "./bot";

// The shared library of skills and MCP servers. Bots only hold ids; these
// helpers keep the ids, names and bot references consistent.

export function newMcpServerId(): string {
  return "mcp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export type LibraryKind = "skill" | "mcp";

function libraryServer(draft: BotMcpServer, name: string, now: string): LibraryMcpServer {
  return {
    id: newMcpServerId(),
    name,
    description: "",
    enabled: draft.enabled,
    config: JSON.parse(JSON.stringify(draft.config)) as BotMcpServer["config"],
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Adds MCP servers to the library. A server whose name and connection match an
 * existing one reuses it; `reuseByName` also reuses any server with the same
 * name (templates: the user may have filled in keys since). Anything else gets a
 * free name. Returns the new library and the ids, in input order.
 */
export function addMcpServers(library: Library, drafts: readonly BotMcpServer[], options: { reuseByName?: boolean; now?: string } = {}): { library: Library; ids: string[] } {
  const now = options.now ?? new Date().toISOString();
  const servers = [...library.mcpServers];
  const ids: string[] = [];
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const config = JSON.stringify(draft.config);
    const existing = servers.find((server) => server.name === name && (options.reuseByName || JSON.stringify(server.config) === config));
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const server = libraryServer(draft, uniqueName(name, new Set([...RESERVED_MCP_NAMES, ...servers.map((entry) => entry.name)])), now);
    servers.push(server);
    ids.push(server.id);
  }
  return { library: { ...library, mcpServers: servers }, ids };
}

/** Adds or refreshes skills after an import; a re-imported skill keeps its switches and creation date. */
/**
 * Adds or refreshes skills. Fetched skills arrive switched off and unreviewed,
 * and a refreshed one needs a new review; a skill written here carries the
 * hash of what the user wrote (`reviewedSha`) and arrives on.
 */
export function upsertSkills(library: Library, skills: readonly (Pick<LibrarySkill, "id" | "description" | "source"> & { reviewedSha?: string })[], now: string = new Date().toISOString()): Library {
  const next = [...library.skills];
  for (const { reviewedSha, ...skill } of skills) {
    const index = next.findIndex((entry) => entry.id === skill.id);
    if (index === -1) next.push({ ...skill, enabled: !!reviewedSha, reviewedSha: reviewedSha ?? null, createdAt: now, updatedAt: now });
    else next[index] = { ...next[index]!, description: skill.description, source: skill.source || next[index]!.source, reviewedSha: reviewedSha ?? null, updatedAt: now };
  }
  return { ...library, skills: next };
}

export function updateMcpServer(library: Library, id: string, patch: Partial<LibraryMcpServer>): Library {
  return { ...library, mcpServers: library.mcpServers.map((server) => (server.id === id ? { ...server, ...patch, updatedAt: new Date().toISOString() } : server)) };
}

export function updateSkill(library: Library, id: string, patch: Partial<LibrarySkill>): Library {
  return { ...library, skills: library.skills.map((skill) => (skill.id === id ? { ...skill, ...patch, updatedAt: new Date().toISOString() } : skill)) };
}

/** Switches a library item on or off for one bot. */
export function setBotUses(bot: Bot, kind: LibraryKind, id: string, on: boolean): Bot {
  const key = kind === "skill" ? "skillIds" : "mcpServerIds";
  const current = bot[key];
  const next = on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id);
  return next === current ? bot : { ...bot, [key]: next };
}

/** Takes a deleted item's id off every bot. */
export function forgetItem(bots: readonly Bot[], kind: LibraryKind, id: string): Bot[] {
  return bots.map((bot) => setBotUses(bot, kind, id, false));
}

/** Rewrites "old/tool" grants after a server is renamed so they keep matching. */
export function renameGrants(bots: readonly Bot[], from: string, to: string): Bot[] {
  if (from === to) return [...bots];
  const prefix = `${from}/`;
  return bots.map((bot) =>
    bot.alwaysAllow.some((grant) => grant.startsWith(prefix))
      ? { ...bot, alwaysAllow: bot.alwaysAllow.map((grant) => (grant.startsWith(prefix) ? `${to}/${grant.slice(prefix.length)}` : grant)) }
      : bot,
  );
}

/** One line describing how a server connects: the command line, or transport and URL. */
export function mcpTarget(config: BotMcpServer["config"]): string {
  return config.type === "stdio" ? [config.command, joinArgs(config.args)].filter(Boolean).join(" ") : `${config.type.toUpperCase()} · ${config.url}`;
}

/** Case-insensitive match on any of the given fields. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}
