// Connected apps through Composio: the catalog, connections and the rules the
// relay applies to each tool call. Composio's Tool Router gives agents a few
// meta-tools (search, schemas, execute, manage connections) over one MCP
// server instead of every app's tools, so the tool list stays small.

import type { AppRule } from "./bot";
import { serverToolName, toolCallName } from "./tool-name";

/** The MCP server name bots see for connected apps; a library server with this name would shadow it. */
export const APPS_MCP_NAME = "composio";

export interface AppCard {
  slug: string;
  name: string;
  description: string;
  /** Composio's logo, always an SVG. */
  logo: string | null;
  /** The app's website host, for a PNG favicon where SVGs can't be drawn. */
  domain: string | null;
  noAuth: boolean;
}

/** A 64 px PNG favicon for a site (the fallback OpenMausBot uses too). */
export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/** The host of an app's website, or null. */
export function appDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export interface AppAccount {
  id: string;
  slug: string;
  status: AppStatus;
  /** The name the user gave it ("work"); bots pick an account by it. */
  alias: string | null;
  /** The provider's name for the sign-in, usually an email address. */
  name: string | null;
  /** Composio's readable id ("gmail_brave-owl"), which its tool router reports for a new sign-in. */
  wordId: string | null;
}

/** How an account reads in lists: its alias, its sign-in name, or the app's name. */
export function accountLabel(account: Pick<AppAccount, "alias" | "name">, appName: string): string {
  return account.alias ?? account.name ?? appName;
}

export type AppStatus = "connected" | "pending" | "failed";

/** Composio's account statuses, folded the way OpenMausBot reads them. */
export function appStatus(status: string | null | undefined, noAuth = false): AppStatus {
  if (noAuth || /^active$/i.test(status ?? "")) return "connected";
  if (/^(initiated|initializing|pending)$/i.test(status ?? "")) return "pending";
  return "failed";
}

/** Composio names the app X "twitter" and prefixes slugs that start with a digit. */
export function canonicalSlug(slug: string): string {
  const lower = slug.trim().toLowerCase();
  return lower === "x" ? "twitter" : lower;
}

/** Sign-in links and MCP endpoints must be https on composio.dev. */
export function isComposioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

/** The app a tool belongs to: its slug is the tool name's prefix, and the longest known slug wins (BLAND_AI_* is bland_ai, not bland). */
export function appForTool(toolSlug: string, knownSlugs: readonly string[]): string | null {
  const name = toolSlug.trim().toUpperCase();
  let best: string | null = null;
  for (const slug of knownSlugs) {
    const prefix = `${slug.toUpperCase()}_`;
    if (name.startsWith(prefix) && (!best || slug.length > best.length)) best = slug;
  }
  return best;
}

/** A bot's limits on one app, as the relay checks a call against them. */
export interface AppLimit {
  /** Tools the bot may run, upper-case; null allows every tool. */
  tools: ReadonlySet<string> | null;
  /** The account every call must use, and its alias; null lets the bot pick. */
  account: { id: string; alias: string | null } | null;
}

/** What the relay checks a bot's app calls against. */
export interface AppAccess {
  /** Apps the bot may use. */
  allowed: readonly string[];
  /** Apps signed in on this host, to tell which app a tool belongs to. */
  connected: readonly string[];
  /** Limits of the allowed apps that have them. */
  limits: ReadonlyMap<string, AppLimit>;
}

type ToolEntry = { tool_slug?: unknown; account?: unknown };

/**
 * Checks a JSON-RPC message from a bot against its app access: why it's
 * refused, or the message to forward with pinned accounts filled in. Only
 * running tools is checked; searching, reading schemas and connecting apps
 * always pass. Composio's remote workbench can run any app's tools, so bots
 * with any limit can't use it.
 */
export function checkAppCall(message: unknown, access: AppAccess): { refusal: string } | { message: unknown } {
  const frame = (message ?? {}) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (frame.method !== "tools/call" || typeof frame.params?.name !== "string") return { message };
  if (/^COMPOSIO_REMOTE_(WORKBENCH|BASH_TOOL)$/.test(frame.params.name)) {
    const limited = access.limits.size > 0 || access.connected.some((slug) => !access.allowed.includes(slug));
    return limited ? { refusal: "Composio's remote workbench can run any app's tools, so it's off for bots limited to some apps, tools or accounts. Run tools with COMPOSIO_MULTI_EXECUTE_TOOL." } : { message };
  }
  if (!/MULTI_EXECUTE_TOOL$|^COMPOSIO_EXECUTE_TOOL$/.test(frame.params.name)) return { message };
  // `{tools: [{tool_slug, account}]}`, or the older single `{tool_slug, account}`.
  const args = (frame.params.arguments ?? {}) as ToolEntry & { tools?: unknown };
  const entries: ToolEntry[] = Array.isArray(args.tools) ? args.tools.map((entry) => (entry && typeof entry === "object" ? (entry as ToolEntry) : {})) : [args];
  const apps = new Set<string>();
  const tools = new Set<string>();
  let account: string | null = null;
  let pinned = false;
  const next = entries.map((entry) => {
    const tool = typeof entry.tool_slug === "string" ? entry.tool_slug.trim().toUpperCase() : "";
    const app = tool ? appForTool(tool, access.connected) : null;
    if (!app) return entry;
    if (!access.allowed.includes(app)) apps.add(app);
    const limit = access.limits.get(app);
    if (!limit) return entry;
    if (limit.tools && !limit.tools.has(tool)) tools.add(tool);
    if (!limit.account) return entry;
    const asked = typeof entry.account === "string" ? entry.account.trim() : "";
    if (asked && asked !== limit.account.id && asked.toLowerCase() !== limit.account.alias?.toLowerCase()) account = limit.account.alias ?? limit.account.id;
    pinned = true;
    return { ...entry, account: limit.account.id };
  });
  const them = (count: number) => (count === 1 ? "it" : "them");
  if (apps.size) return { refusal: `This bot isn't allowed to use ${[...apps].join(", ")}. Ask the user to switch ${them(apps.size)} on under the bot's Access settings in Paseo.` };
  if (tools.size) return { refusal: `This bot isn't allowed to run ${[...tools].join(", ")}. Ask the user to allow ${them(tools.size)} under the bot's Access settings in Paseo.` };
  if (account) return { refusal: `This bot may only use the account "${account}" for that app. Leave "account" out to use it.` };
  if (!pinned) return { message };
  return { message: { ...frame, params: { ...frame.params, arguments: Array.isArray(args.tools) ? { ...args, tools: next } : next[0] } } };
}

/** One of an app's tools, for choosing which a bot may run. */
export interface AppTool {
  slug: string;
  name: string;
  /** Composio marks it read-only. */
  readOnly: boolean;
}

/** A bot's rules with one app's rule set; a rule allowing everything is dropped. */
export function withAppRule(rules: Readonly<Record<string, AppRule>>, slug: string, rule: AppRule): Record<string, AppRule> {
  const next = { ...rules };
  if (rule.tools === "all" && !rule.account) delete next[slug];
  else next[slug] = rule;
  return next;
}

/** A sign-in a bot started with COMPOSIO_MANAGE_CONNECTIONS, shown as a card in its chat (a type, so it's timeline JSON). */
export type AppSignIn = {
  slug: string;
  /** Composio's sign-in page; it expires ten minutes after the call. */
  url: string;
  /** The readable id of the account being signed in, to tell when it's done. */
  wordId: string | null;
  alias: string | null;
};

/** Composio's `data.results` in a tool output, however the provider wrapped it: JSON text, content blocks or `{output}`. */
function composioResults(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4 || value === null || typeof value !== "object") {
    if (typeof value !== "string" || depth > 4) return null;
    try {
      return composioResults(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.reduce<Record<string, unknown> | null>((found, entry) => found ?? composioResults(entry, depth + 1), null);
  const record = value as { data?: { results?: unknown }; output?: unknown; text?: unknown; content?: unknown };
  const results = record.data?.results;
  if (results && typeof results === "object" && !Array.isArray(results)) return results as Record<string, unknown>;
  return composioResults(record.output, depth + 1) ?? composioResults(record.text, depth + 1) ?? composioResults(record.content, depth + 1);
}

/**
 * The sign-ins a finished COMPOSIO_MANAGE_CONNECTIONS call started, from its
 * output: `{data: {results: {notion: {redirect_url, accounts: [{id, alias}]}}}}`.
 */
export function appSignIns(call: { name: string; status: string; detail: unknown; metadata?: unknown }): AppSignIn[] {
  if (call.status !== "completed" || serverToolName(toolCallName(call), APPS_MCP_NAME) !== "COMPOSIO_MANAGE_CONNECTIONS") return [];
  const results = composioResults((call.detail as { output?: unknown } | null)?.output) ?? {};
  const signIns: AppSignIn[] = [];
  for (const [slug, value] of Object.entries(results)) {
    const result = (value ?? {}) as { redirect_url?: unknown; accounts?: { id?: unknown; alias?: unknown }[] };
    const url = result.redirect_url;
    if (typeof url !== "string" || !isComposioUrl(url)) continue;
    const account = Array.isArray(result.accounts) ? result.accounts[0] : undefined;
    signIns.push({
      slug: canonicalSlug(slug),
      url,
      wordId: typeof account?.id === "string" ? account.id : null,
      alias: typeof account?.alias === "string" && account.alias.trim() ? account.alias.trim() : null,
    });
  }
  return signIns;
}

/** A connected app as a bot's prompt lists it. */
export interface PromptApp {
  name: string;
  /** Its accounts when the bot picks one of several: what Composio takes as "account" (the alias, or the id of an unnamed one) and the sign-in name. */
  accounts: { account: string; name: string | null }[];
  /** The tools the bot may run, as in its rule for the app. */
  tools: AppRule["tools"];
}

/** `Gmail`, or with its accounts and limits: `Gmail (accounts: "work" = me@work.com, "personal"; read-only tools)`. */
function promptAppName(app: PromptApp): string {
  const notes = [
    app.accounts.length > 1 ? `accounts: ${app.accounts.map((entry) => `"${entry.account}"${entry.name ? ` = ${entry.name}` : ""}`).join(", ")}` : null,
    app.tools === "read" ? "read-only tools" : Array.isArray(app.tools) ? `only ${app.tools.join(", ")}` : null,
  ].filter(Boolean);
  return notes.length ? `${app.name} (${notes.join("; ")})` : app.name;
}

/** The prompt section for a bot with connected apps. */
export function appsPrompt(apps: readonly PromptApp[]): string {
  return [
    `Connected apps are available through the MCP server "${APPS_MCP_NAME}". You may use: ${apps.map(promptAppName).join(", ")}.`,
    "Find a tool with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL.",
    ...(apps.some((app) => app.accounts.length > 1) ? ['When an app has several accounts, pass the one to use as "account" in each COMPOSIO_MULTI_EXECUTE_TOOL entry, and ask the user when it isn\'t clear which one they mean.'] : []),
    "If a task needs an app that isn't connected, add it with COMPOSIO_MANAGE_CONNECTIONS: the user gets a card in this chat to sign in. Then end your turn; they'll tell you when it's connected.",
  ].join(" ");
}
