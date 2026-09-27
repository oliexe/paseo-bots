import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appDomain, appStatus, canonicalSlug, isComposioUrl, type AppAccount, type AppCard } from "../shared/apps";
import { pluginDataPath } from "./bot-home";

// Composio over its REST API, the way OpenMausBot's self-hosted mode does it:
// one Tool Router Session per install, under one Composio user, so every
// connected account belongs to this Paseo host. The project key stays in a
// file only this process reads; clients never see it.

/** Tests point this at a local fake; its URLs are then trusted like composio.dev's. */
const ORIGIN_OVERRIDE = () => process.env.PASEO_BOTS_COMPOSIO_ORIGIN?.replace(/\/$/, "");
const ORIGIN = () => ORIGIN_OVERRIDE() ?? "https://backend.composio.dev";
const API = () => `${ORIGIN()}/api/v3.1`;
const CATALOG_API = () => `${ORIGIN()}/api/v3`;
const CATALOG_TTL_MS = 10 * 60_000;
const CONNECTED_TTL_MS = 30_000;
const MAX_PAGES = 20;

interface State {
  apiKey: string | null;
  /** Composio user the connections belong to; kept when the key is removed so they survive re-adding it. */
  userId: string;
  sessionId: string | null;
  mcpUrl: string | null;
  /** Signs each bot's relay token. */
  secret: string;
  /** Last relay port, reused so running chats keep their MCP URL across restarts. */
  port: number | null;
}

function statePath(): string {
  return join(pluginDataPath(), "composio.json");
}

let cached: State | null = null;

export async function readState(): Promise<State> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    cached = { apiKey: null, userId: `paseo_bots_${randomUUID()}`, sessionId: null, mcpUrl: null, secret: randomBytes(32).toString("hex"), port: null };
  }
  return cached;
}

export async function writeState(patch: Partial<State>): Promise<State> {
  const next = { ...(await readState()), ...patch };
  cached = next;
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(statePath(), 0o600).catch(() => {});
  return next;
}

/** An abort signal that fires after `ms` (AbortSignal.timeout isn't in this project's Node types). */
export function deadline(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function trusted(url: string): boolean {
  const override = ORIGIN_OVERRIDE();
  return isComposioUrl(url) || (!!override && url.startsWith(`${override}/`));
}

function headers(apiKey: string, json = false): Record<string, string> {
  return { "x-api-key": apiKey, ...(json ? { "content-type": "application/json" } : {}) };
}

async function failure(response: Response, fallback: string): Promise<Error> {
  const raw = await response.text().catch(() => "");
  let message = raw.trim().slice(0, 300);
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } | string };
    message = String(body.message ?? (typeof body.error === "object" ? body.error?.message : body.error) ?? message);
  } catch {
    // Not JSON; keep the text.
  }
  return new Error(message || fallback);
}

// ---------------------------------------------------------------- session

interface SessionResponse {
  session_id: string;
  mcp: { type: string; url: string };
}

async function createSession(apiKey: string, userId: string): Promise<SessionResponse> {
  const response = await fetch(`${API()}/tool_router/session`, {
    method: "POST",
    headers: headers(apiKey, true),
    body: JSON.stringify({
      user_id: userId,
      manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: false },
    }),
    signal: deadline(30_000),
  });
  if (!response.ok) throw await failure(response, `Composio rejected the key (HTTP ${response.status})`);
  const session = (await response.json()) as SessionResponse;
  if (!session.session_id || !session.mcp?.url || !trusted(session.mcp.url)) throw new Error("Composio returned an unexpected session.");
  return session;
}

async function sessionExists(apiKey: string, sessionId: string): Promise<boolean> {
  const response = await fetch(`${API()}/tool_router/session/${encodeURIComponent(sessionId)}`, { headers: headers(apiKey), signal: deadline(15_000) });
  if (response.status === 404) return false;
  if (!response.ok) throw await failure(response, `Composio session: HTTP ${response.status}`);
  return true;
}

/** Saves a project key after proving it works by opening a session with it. */
export async function setKey({ key }: { key: string }) {
  const apiKey = key.trim();
  if (!apiKey.startsWith("ak_")) throw new Error("Composio project keys start with ak_.");
  const state = await readState();
  const session = await createSession(apiKey, state.userId);
  await writeState({ apiKey, sessionId: session.session_id, mcpUrl: session.mcp.url });
  forgetCaches();
  return { ok: true };
}

export async function removeKey() {
  await writeState({ apiKey: null, sessionId: null, mcpUrl: null });
  forgetCaches();
  return { ok: true };
}

export async function status() {
  const { apiKey } = await readState();
  return { configured: !!apiKey, keyHint: apiKey ? `ak_…${apiKey.slice(-4)}` : null };
}

/** The key and a live session, recreating the session when Composio has dropped it. */
export async function session(options: { recreate?: boolean } = {}): Promise<{ apiKey: string; sessionId: string; mcpUrl: string }> {
  const state = await readState();
  if (!state.apiKey) throw new Error("Connected apps aren't set up. Add a Composio key in Skills & Tools.");
  if (!options.recreate && state.sessionId && state.mcpUrl) return { apiKey: state.apiKey, sessionId: state.sessionId, mcpUrl: state.mcpUrl };
  if (!options.recreate && state.sessionId && (await sessionExists(state.apiKey, state.sessionId)) && state.mcpUrl) {
    return { apiKey: state.apiKey, sessionId: state.sessionId, mcpUrl: state.mcpUrl };
  }
  const fresh = await createSession(state.apiKey, state.userId);
  await writeState({ sessionId: fresh.session_id, mcpUrl: fresh.mcp.url });
  return { apiKey: state.apiKey, sessionId: fresh.session_id, mcpUrl: fresh.mcp.url };
}

// ---------------------------------------------------------------- catalog and accounts

let catalogCache: { key: string; at: number; apps: AppCard[] } | null = null;
let connectedCache: { key: string; at: number; accounts: AppAccount[] } | null = null;

function forgetCaches() {
  catalogCache = null;
  connectedCache = null;
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

interface ToolkitItem {
  slug?: string;
  key?: string;
  name?: string;
  no_auth?: boolean;
  logo?: string;
  meta?: { description?: string; logo?: string; app_url?: string };
}

/** Every app Composio offers, most used first. Cached for ten minutes. */
export async function catalog(): Promise<{ apps: AppCard[] }> {
  const { apiKey } = await readState();
  if (!apiKey) return { apps: [] };
  const key = fingerprint(apiKey);
  if (catalogCache?.key === key && Date.now() - catalogCache.at < CATALOG_TTL_MS) return { apps: catalogCache.apps };
  const apps: AppCard[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${CATALOG_API()}/toolkits?${params}`, { headers: headers(apiKey), signal: deadline(20_000) });
    if (!response.ok) {
      // Keep what earlier pages returned; only the first page failing is an error.
      if (apps.length) break;
      throw await failure(response, `Composio catalog: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { items?: ToolkitItem[]; next_cursor?: string | null };
    for (const item of body.items ?? []) {
      const raw = item.slug ?? item.key ?? item.name;
      if (!raw) continue;
      const slug = canonicalSlug(raw);
      if (seen.has(slug)) continue;
      seen.add(slug);
      apps.push({
        slug,
        name: item.name ?? slug,
        description: (item.meta?.description ?? "").trim(),
        logo: item.meta?.logo ?? item.logo ?? null,
        domain: appDomain(item.meta?.app_url),
        noAuth: item.no_auth === true,
      });
    }
    const next = body.next_cursor?.trim();
    if (!next || next === cursor) break;
    cursor = next;
  }
  catalogCache = { key, at: Date.now(), apps };
  return { apps };
}

interface AccountItem {
  id?: string;
  status?: string;
  toolkit?: { slug?: string };
}

/** This host's accounts, newest first. Cached briefly; `fresh` skips the cache while a sign-in is pending. */
export async function accounts({ fresh }: { fresh?: boolean } = {}): Promise<{ accounts: AppAccount[] }> {
  const { apiKey, userId } = await readState();
  if (!apiKey) return { accounts: [] };
  const key = fingerprint(apiKey);
  if (!fresh && connectedCache?.key === key && Date.now() - connectedCache.at < CONNECTED_TTL_MS) return { accounts: connectedCache.accounts };
  const found: AppAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "50", user_ids: userId, order_by: "updated_at", order_direction: "desc" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${API()}/connected_accounts?${params}`, { headers: headers(apiKey), signal: deadline(15_000) });
    if (!response.ok) throw await failure(response, `Composio accounts: HTTP ${response.status}`);
    const body = (await response.json()) as { items?: AccountItem[]; next_cursor?: string | null };
    for (const item of body.items ?? []) {
      if (item.id && item.toolkit?.slug) found.push({ id: item.id, slug: canonicalSlug(item.toolkit.slug), status: appStatus(item.status) });
    }
    const next = body.next_cursor?.trim();
    if (!next || next === cursor) break;
    cursor = next;
  }
  connectedCache = { key, at: Date.now(), accounts: found };
  return { accounts: found };
}

/** Slugs of apps with a working account. */
export async function connectedSlugs(): Promise<string[]> {
  const { accounts: list } = await accounts().catch(() => ({ accounts: [] as AppAccount[] }));
  return [...new Set(list.filter((account) => account.status === "connected").map((account) => account.slug))];
}

/** A Composio-hosted sign-in link for an app. The user finishes in their browser; the app polls `accounts`. */
export async function connect({ slug }: { slug: string }) {
  const link = async (sessionId: string, apiKey: string) =>
    fetch(`${API()}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      headers: headers(apiKey, true),
      body: JSON.stringify({ toolkit: canonicalSlug(slug) }),
      signal: deadline(30_000),
    });
  let current = await session();
  let response = await link(current.sessionId, current.apiKey);
  if (response.status === 404) {
    current = await session({ recreate: true });
    response = await link(current.sessionId, current.apiKey);
  }
  if (!response.ok) throw await failure(response, `Composio sign-in: HTTP ${response.status}`);
  const body = (await response.json()) as { redirect_url?: string };
  if (!body.redirect_url || !trusted(body.redirect_url)) throw new Error("Composio returned an unexpected sign-in link.");
  connectedCache = null;
  return { url: body.redirect_url };
}

/** Disconnects one account after checking it belongs to this host's Composio user. */
export async function disconnect({ accountId }: { accountId: string }) {
  const { apiKey } = await readState();
  if (!apiKey) throw new Error("Connected apps aren't set up.");
  const { accounts: mine } = await accounts({ fresh: true });
  if (!mine.some((account) => account.id === accountId)) throw new Error("That account isn't connected on this host.");
  const response = await fetch(`${API()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, {
    method: "DELETE",
    headers: headers(apiKey),
    signal: deadline(15_000),
  });
  if (!response.ok && response.status !== 404) throw await failure(response, `Composio disconnect: HTTP ${response.status}`);
  connectedCache = null;
  return { ok: true };
}
