import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotMcpServerSchema, BotSchema, McpServerConfigSchema, McpToolSchema } from "./bot";
import { ProposalSchema } from "./proposals";

const BotId = z.string().regex(/^[a-z0-9-]+$/);
/** "MEMORY.md" or a topic file such as "projects.md" (stored under memory/). */
export const MemoryFileName = z.string().regex(/^[A-Za-z0-9 ._-]+\.md$/);
export const SkillName = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * Creates (if needed) the Bots project folder and this bot's folder inside it.
 * `root` backs the Bots project, `path` the bot's workspace.
 */
export const ensureBotHomeRpc = defineRpc({
  name: "bots.ensure-home",
  input: z.object({ botId: BotId }),
  output: z.object({ root: z.string(), path: z.string() }),
});

/** Sent by the app on start so the daemon side can run routines. */
export const helloRpc = defineRpc({
  name: "bots.hello",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean() }),
});

const PromptSectionSchema = z.object({ title: z.string(), text: z.string() });

/** The bot's system prompt as it would be sent now, with its memory and skills. */
export const systemPromptRpc = defineRpc({
  name: "bots.system-prompt",
  input: z.object({ bot: BotSchema, local: z.boolean() }),
  output: z.object({ systemPrompt: z.string(), sections: z.array(PromptSectionSchema) }),
});

const MemoryFileSchema = z.object({ name: MemoryFileName, bytes: z.number(), lines: z.number(), topic: z.boolean() });

export const memoryListRpc = defineRpc({
  name: "bots.memory.list",
  input: z.object({ botId: BotId }),
  output: z.object({ folder: z.string(), files: z.array(MemoryFileSchema), injectedLines: z.number(), injectedBytes: z.number() }),
});

export const memoryReadRpc = defineRpc({
  name: "bots.memory.read",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ text: z.string() }),
});

export const memoryWriteRpc = defineRpc({
  name: "bots.memory.write",
  input: z.object({ botId: BotId, name: MemoryFileName, text: z.string().max(200_000) }),
  output: z.object({ ok: z.boolean() }),
});

export const memoryDeleteRpc = defineRpc({
  name: "bots.memory.delete",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ ok: z.boolean() }),
});

const LogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The daily log: its days, and one day's text when `day` is given. */
export const memoryLogRpc = defineRpc({
  name: "bots.memory.log",
  input: z.object({ botId: BotId, day: LogDay.optional() }),
  output: z.object({ days: z.array(z.object({ day: z.string(), lines: z.number() })), text: z.string().nullable() }),
});

export const memoryLogDeleteRpc = defineRpc({
  name: "bots.memory.log-delete",
  input: z.object({ botId: BotId, day: LogDay }),
  output: z.object({ ok: z.boolean() }),
});

export const JournalEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  file: z.string(),
  actor: z.enum(["bot", "you"]),
  via: z.enum(["chat", "app", "disk", "undo"]),
  chat: z.object({ id: z.string(), title: z.string() }).nullable(),
  kind: z.enum(["created", "edited", "deleted"]),
  diff: z.string(),
  added: z.number(),
  removed: z.number(),
  canUndo: z.boolean(),
});
export type JournalRow = z.infer<typeof JournalEntrySchema>;

/** Recent changes to a bot's memory files, newest first. */
export const memoryJournalRpc = defineRpc({
  name: "bots.memory.journal",
  input: z.object({ botId: BotId }),
  output: z.object({ entries: z.array(JournalEntrySchema) }),
});

/** Puts a memory file back the way it was before a change. */
export const memoryUndoRpc = defineRpc({
  name: "bots.memory.undo",
  input: z.object({ botId: BotId, id: z.string().regex(/^j-[a-z0-9]+$/) }),
  output: z.object({ ok: z.boolean() }),
});

const ImportedSkillSchema = z.object({ id: SkillName, description: z.string(), source: z.string() });

/** Imports skills into the library from "owner/repo", "owner/repo/path", a GitHub URL or a raw SKILL.md URL. */
export const skillImportRpc = defineRpc({
  name: "bots.library.import-skills",
  input: z.object({ source: z.string().min(1).max(500) }),
  output: z.object({ skills: z.array(ImportedSkillSchema) }),
});

export const skillReadRpc = defineRpc({
  name: "bots.library.read-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ text: z.string(), sha: z.string().nullable(), missing: z.boolean(), path: z.string(), files: z.array(z.string()) }),
});

/** Creates or replaces a library skill's SKILL.md; returns its frontmatter description and hash. */
export const skillWriteRpc = defineRpc({
  name: "bots.library.write-skill",
  input: z.object({ id: SkillName, text: z.string().max(256_000) }),
  output: z.object({ description: z.string(), sha: z.string() }),
});

export const skillDeleteRpc = defineRpc({
  name: "bots.library.delete-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ ok: z.boolean() }),
});

/** Starts or connects to an MCP server, lists its tools and disconnects. */
export const mcpProbeRpc = defineRpc({
  name: "bots.library.test-mcp",
  input: z.object({ config: McpServerConfigSchema }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), tools: z.array(McpToolSchema) }), z.object({ ok: z.literal(false), error: z.string() })]),
});

export const RoutineRunStateSchema = z.object({
  lastRunAt: z.string().nullable(),
  lastStatus: z.enum(["started", "skipped-busy", "skipped-missed", "failed"]).nullable(),
  lastError: z.string().nullable(),
  lastAgentId: z.string().nullable(),
});
export type RoutineRunState = z.infer<typeof RoutineRunStateSchema>;

export const routineStatusRpc = defineRpc({
  name: "bots.routines.status",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean(), runs: z.record(z.string(), RoutineRunStateSchema) }),
});

export const routineRunNowRpc = defineRpc({
  name: "bots.routines.run-now",
  input: z.object({ botId: BotId, routineId: z.string() }),
  output: z.object({ agentId: z.string() }),
});

/** A shareable bot file: identity, soul, its skills and MCP servers, routines (paused) and optionally memory. Secrets are redacted. */
export const exportBotRpc = defineRpc({
  name: "bots.export",
  input: z.object({ bot: BotSchema, includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Writes an exported bot's files for `botId`; returns the bot fields to save and what to add to the library. */
export const importBotRpc = defineRpc({
  name: "bots.import",
  input: z.object({ botId: BotId, json: z.string().max(5_000_000) }),
  output: z.object({ bot: BotSchema, skills: z.array(ImportedSkillSchema), mcpServers: z.array(BotMcpServerSchema) }),
});

/** Stores a picked file on this host so it can be sent as an `uploaded_file` attachment. */
export const uploadRpc = defineRpc({
  name: "bots.upload",
  input: z.object({ botId: BotId, fileName: z.string().min(1).max(255), dataBase64: z.string().max(36_000_000) }),
  output: z.object({ path: z.string(), size: z.number() }),
});

// ---------------------------------------------------------------- connected apps

const AppCardSchema = z.object({ slug: z.string(), name: z.string(), description: z.string(), logo: z.string().nullable(), domain: z.string().nullable(), noAuth: z.boolean() });
const AppAccountSchema = z.object({ id: z.string(), slug: z.string(), status: z.enum(["connected", "pending", "failed"]) });
const AppSlug = z.string().regex(/^[a-z0-9_-]+$/);

/** Whether a Composio project key is saved on this host; only its last characters are shown. */
export const appsStatusRpc = defineRpc({
  name: "bots.apps.status",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), keyHint: z.string().nullable() }),
});

/** Saves a Composio project key after opening a session with it. */
export const appsSetKeyRpc = defineRpc({
  name: "bots.apps.set-key",
  input: z.object({ key: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

export const appsRemoveKeyRpc = defineRpc({
  name: "bots.apps.remove-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const appsCatalogRpc = defineRpc({
  name: "bots.apps.catalog",
  input: z.object({}),
  output: z.object({ apps: z.array(AppCardSchema) }),
});

export const appsAccountsRpc = defineRpc({
  name: "bots.apps.accounts",
  input: z.object({ fresh: z.boolean().optional() }),
  output: z.object({ accounts: z.array(AppAccountSchema) }),
});

/** A Composio-hosted sign-in link for an app. */
export const appsConnectRpc = defineRpc({
  name: "bots.apps.connect",
  input: z.object({ slug: AppSlug }),
  output: z.object({ url: z.string() }),
});

export const appsDisconnectRpc = defineRpc({
  name: "bots.apps.disconnect",
  input: z.object({ accountId: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * The plugin's MCP servers for a new chat of a local bot: its tools, and
 * connected apps when the bot uses them. `agentId` is the chat's id, picked
 * before the chat is created.
 */
export const mountRpc = defineRpc({
  name: "bots.mount",
  input: z.object({ botId: BotId, agentId: z.uuid() }),
  output: z.object({ tools: McpServerConfigSchema, apps: McpServerConfigSchema.nullable() }),
});

// ---------------------------------------------------------------- proposals

const ProposalId = z.string().regex(/^p-[a-z0-9]+$/);

/** A proposal a bot made in a chat; null once it's gone. */
export const proposalGetRpc = defineRpc({
  name: "bots.proposals.get",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema.nullable() }),
});

/** Saves a proposed skill to the library; the app then turns it on for the bot. */
export const proposalAcceptRpc = defineRpc({
  name: "bots.proposals.accept",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema, skill: z.object({ id: SkillName, description: z.string(), sha: z.string() }) }),
});

export const proposalDismissRpc = defineRpc({
  name: "bots.proposals.dismiss",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema }),
});
