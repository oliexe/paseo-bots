// Connected apps through Composio: the catalog, connections and the rules the
// relay applies to each tool call. Composio's Tool Router gives agents a few
// meta-tools (search, schemas, execute, manage connections) over one MCP
// server instead of every app's tools, so the tool list stays small.

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

/** Tool names in a COMPOSIO_MULTI_EXECUTE_TOOL call: `{tools: [{tool_slug}]}`, or the older single `{tool_slug}`. */
export function executedTools(args: unknown): string[] {
  const value = (args ?? {}) as { tools?: unknown; tool_slug?: unknown };
  if (Array.isArray(value.tools)) {
    return value.tools.flatMap((entry) => (entry && typeof (entry as { tool_slug?: unknown }).tool_slug === "string" ? [(entry as { tool_slug: string }).tool_slug] : []));
  }
  return typeof value.tool_slug === "string" ? [value.tool_slug] : [];
}

/**
 * Why a JSON-RPC message from a bot is refused, or null to let it through.
 * Only executing a tool of a connected app the bot isn't allowed is refused;
 * searching, reading schemas and connecting apps always pass.
 */
export function appCallRefusal(message: unknown, allowed: readonly string[], connected: readonly string[]): string | null {
  const frame = (message ?? {}) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (frame.method !== "tools/call" || typeof frame.params?.name !== "string") return null;
  if (!/MULTI_EXECUTE_TOOL$|^COMPOSIO_EXECUTE_TOOL$/.test(frame.params.name)) return null;
  const blocked = new Set<string>();
  for (const tool of executedTools(frame.params.arguments)) {
    const app = appForTool(tool, connected);
    if (app && !allowed.includes(app)) blocked.add(app);
  }
  if (blocked.size === 0) return null;
  const names = [...blocked].join(", ");
  return `This bot isn't allowed to use ${names}. Ask the user to switch ${blocked.size === 1 ? "it" : "them"} on under the bot's Access settings in Paseo.`;
}

/** The prompt section for a bot with connected apps. */
export function appsPrompt(names: readonly string[]): string {
  return [
    `Connected apps are available through the MCP server "${APPS_MCP_NAME}". You may use: ${names.join(", ")}.`,
    "Find a tool with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL.",
    "If a task needs an app that isn't connected, use COMPOSIO_MANAGE_CONNECTIONS to get a sign-in link and give it to the user.",
  ].join(" ");
}
