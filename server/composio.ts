import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { appDomain, appStatus, canonicalSlug, isComposioUrl, type AppAccount, type AppCard, type AppTool } from "../shared/apps";
import { pluginDataPath } from "./bot-home";

// Browser sign-in uses Composio's CLI approval flow and personal project.
// Older installations can keep using their project key and host-specific user.
// Credentials stay on the daemon; clients only receive account and login views.

/** Tests point this at a local fake; its URLs are then trusted like composio.dev's. */
const ORIGIN_OVERRIDE = () => process.env.PASEO_BOTS_COMPOSIO_ORIGIN?.replace(/\/$/, "");
const ORIGIN = () => ORIGIN_OVERRIDE() ?? "https://backend.composio.dev";
const API = () => `${ORIGIN()}/api/v3.1`;
const CATALOG_API = () => `${ORIGIN()}/api/v3`;
const CATALOG_TTL_MS = 10 * 60_000;
const CONNECTED_TTL_MS = 30_000;
const MAX_PAGES = 20;
const MAX_ACCOUNTS_PER_APP = 5;

interface State {
  apiKey: string | null;
  account?: Account | null;
  /** Composio user the connections belong to; kept when the key is removed so they survive re-adding it. */
  userId: string;
  sessionId: string | null;
  mcpUrl: string | null;
  /** Signs each bot's relay token. */
  secret: string;
  /** Last relay port, reused so running chats keep their MCP URL across restarts. */
  port: number | null;
  /** Whether the session allows several accounts per app; older sessions are replaced. */
  multiAccount?: boolean;
}

const AccountSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string(),
  organization: z.string(),
});
type Account = z.infer<typeof AccountSchema>;

function statePath(): string {
  return join(pluginDataPath(), "composio.json");
}

let cached: State | null = null;
let stateWrites: Promise<unknown> = Promise.resolve();

export async function readState(): Promise<State> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    cached = { apiKey: null, userId: `paseo_bots_${randomUUID()}`, sessionId: null, mcpUrl: null, secret: randomBytes(32).toString("hex"), port: null };
  }
  return cached;
}

export function writeState(patch: Partial<State>): Promise<State> {
  const write = stateWrites.then(async () => {
    const next = { ...(await readState()), ...patch };
    await mkdir(dirname(statePath()), { recursive: true });
    await writeFile(statePath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(statePath(), 0o600);
    cached = next;
    return next;
  });
  stateWrites = write.catch(() => {});
  return write;
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

function headers(apiKey: string, json = false, account?: Account | null): Record<string, string> {
  return {
    ...(account ? { "x-user-api-key": apiKey, "x-org-id": account.orgId, "x-project-id": account.projectId } : { "x-api-key": apiKey }),
    ...(json ? { "content-type": "application/json" } : {}),
  };
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

async function createSession(apiKey: string, userId: string, account?: Account | null): Promise<SessionResponse> {
  const response = await fetch(`${API()}/tool_router/session`, {
    method: "POST",
    headers: headers(apiKey, true, account),
    redirect: "error",
    body: JSON.stringify({
      user_id: userId,
      manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: false },
      // Several accounts per app (work and personal Gmail); bots pick one by its alias.
      multi_account: { enable: true, max_accounts_per_toolkit: MAX_ACCOUNTS_PER_APP },
    }),
    signal: deadline(30_000),
  });
  if (!response.ok) throw await failure(response, `Composio rejected the key (HTTP ${response.status})`);
  const session = (await response.json()) as SessionResponse;
  if (!session.session_id || !session.mcp?.url || !trusted(session.mcp.url)) throw new Error("Composio returned an unexpected session.");
  return session;
}

/** Saves a project key after proving it works by opening a session with it. */
export async function setKey({ key }: { key: string }) {
  const apiKey = key.trim();
  if (!apiKey.startsWith("ak_")) throw new Error("Composio project keys start with ak_.");
  const state = await readState();
  const session = await createSession(apiKey, state.userId);
  cancelLogin();
  await writeState({ apiKey, account: null, sessionId: session.session_id, mcpUrl: session.mcp.url, multiAccount: true });
  forgetCaches();
  return { ok: true };
}

export async function removeKey() {
  cancelLogin();
  await writeState({ apiKey: null, account: null, sessionId: null, mcpUrl: null });
  forgetCaches();
  return { ok: true };
}

export async function status() {
  const { apiKey, account } = await readState();
  return {
    configured: !!apiKey,
    keyHint: apiKey && !account ? `ak_…${apiKey.slice(-4)}` : null,
    account: apiKey && account ? { email: account.email, organization: account.organization } : null,
    login: pendingLogin ? loginView(pendingLogin) : null,
    loginError,
  };
}

interface PendingLogin {
  id: string;
  code: string;
  url: string;
  expiresAt: string;
  timer?: ReturnType<typeof setTimeout>;
}
let pendingLogin: PendingLogin | null = null;
let loginError: string | null = null;
let loginGeneration = 0;
let startingLogin: Promise<ReturnType<typeof loginView>> | null = null;
const loginView = ({ code, url, expiresAt }: PendingLogin) => ({ code, url, expiresAt });

/** Login session IDs and credentials never leave the daemon except in the approval URL. */
async function loginRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API()}${path}`, { ...options, redirect: "error", signal: deadline(15_000) });
  // These endpoints can return credentials, so don't echo response bodies in errors.
  if (!response.ok) throw new Error(`Composio sign-in failed (HTTP ${response.status}). Please try again.`);
  return response.json();
}

export function cancelLogin() {
  loginGeneration++;
  if (pendingLogin?.timer) clearTimeout(pendingLogin.timer);
  pendingLogin = null;
  startingLogin = null;
  loginError = null;
  return { ok: true };
}

/** The same browser approval used by `composio login`, with no local callback server. */
export async function startLogin() {
  if (pendingLogin && Date.parse(pendingLogin.expiresAt) > Date.now()) return loginView(pendingLogin);
  if (startingLogin) return startingLogin;
  cancelLogin();
  const generation = loginGeneration;
  const attempt = (async () => {
    const result = z.object({ id: z.string().min(1), code: z.string(), expiresAt: z.string().datetime() }).safeParse(
      await loginRequest("/cli/create-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "user" }) }),
    );
    if (!result.success || Date.parse(result.data.expiresAt) <= Date.now()) throw new Error("Composio returned an invalid sign-in session. Please try again.");
    if (generation !== loginGeneration) throw new Error("Sign-in was canceled.");
    pendingLogin = { ...result.data, url: `https://dashboard.composio.dev/?cliKey=${encodeURIComponent(result.data.id)}` };
    scheduleLogin(pendingLogin);
    return loginView(pendingLogin);
  })();
  startingLogin = attempt;
  try {
    return await attempt;
  } finally {
    if (startingLogin === attempt) startingLogin = null;
  }
}

function scheduleLogin(login: PendingLogin) {
  login.timer = setTimeout(() => void pollLogin(login), 3_000);
  login.timer.unref?.();
}

async function pollLogin(login: PendingLogin) {
  if (pendingLogin !== login) return;
  if (Date.parse(login.expiresAt) <= Date.now()) {
    pendingLogin = null;
    loginError = "Composio sign-in expired. Please sign in again.";
    return;
  }
  try {
    const linked = z.object({ status: z.string(), api_key: z.string().nullish() }).safeParse(
      await loginRequest(`/cli/get-session?${new URLSearchParams({ id: login.id })}`),
    );
    if (!linked.success) throw new Error("Composio returned an invalid sign-in response.");
    if (pendingLogin !== login) return;
    if (linked.data.status === "pending") return scheduleLogin(login);
    if (linked.data.status !== "linked" || !linked.data.api_key) throw new Error("Composio sign-in wasn't approved. Please try again.");
    const apiKey = linked.data.api_key;
    const info = z.object({ project: z.object({ org: z.object({ id: z.string().min(1), name: z.string() }) }), org_member: z.object({ email: z.string() }) }).safeParse(
      await loginRequest("/auth/session/info", { headers: { "x-user-api-key": apiKey } }),
    );
    if (!info.success) throw new Error("Couldn't read your Composio account. Please sign in again.");
    const org = info.data.project.org;
    const consumer = z.object({ project_nano_id: z.string().min(1), consumer_user_id: z.string().min(1) }).safeParse(
      await loginRequest("/org/consumer/project/resolve", { method: "POST", headers: { "x-user-api-key": apiKey, "x-org-id": org.id } }),
    );
    if (!consumer.success) throw new Error("Couldn't open your personal Composio project. Please sign in again.");
    const account = AccountSchema.parse({ orgId: org.id, projectId: consumer.data.project_nano_id, userId: consumer.data.consumer_user_id, email: info.data.org_member.email, organization: org.name });
    if (pendingLogin !== login) return;
    const session = await createSession(apiKey, account.userId, account);
    if (pendingLogin !== login) return;
    await writeState({ apiKey, account, sessionId: session.session_id, mcpUrl: session.mcp.url, multiAccount: true });
    forgetCaches();
    if (pendingLogin === login) {
      pendingLogin = null;
      loginError = null;
    }
  } catch {
    if (pendingLogin !== login) return;
    // Keep credentials and server responses out of client errors. A new attempt is explicit.
    pendingLogin = null;
    loginError = "Couldn't finish signing in to Composio. Please try again.";
  }
}

/** The key and a live session, recreating the session when Composio has dropped it. */
export async function session(options: { recreate?: boolean } = {}): Promise<{ apiKey: string; sessionId: string; mcpUrl: string; headers: Record<string, string> }> {
  const state = await readState();
  if (!state.apiKey) throw new Error("Connected apps aren't set up. Sign in to Composio in Skills & Tools.");
  const auth = headers(state.apiKey, false, state.account);
  // A session from before several accounts per app were allowed is replaced once.
  const current = !options.recreate && state.multiAccount;
  if (current && state.sessionId && state.mcpUrl) return { apiKey: state.apiKey, sessionId: state.sessionId, mcpUrl: state.mcpUrl, headers: auth };
  const fresh = await createSession(state.apiKey, state.account?.userId ?? state.userId, state.account);
  const latest = await readState();
  if (latest.apiKey !== state.apiKey || latest.account !== state.account) throw new Error("Composio account changed. Please try again.");
  await writeState({ sessionId: fresh.session_id, mcpUrl: fresh.mcp.url, multiAccount: true });
  return { apiKey: state.apiKey, sessionId: fresh.session_id, mcpUrl: fresh.mcp.url, headers: auth };
}

// ---------------------------------------------------------------- catalog and accounts

let catalogCache: { key: string; at: number; apps: AppCard[] } | null = null;
let connectedCache: { key: string; at: number; accounts: AppAccount[] } | null = null;
const toolsCache = new Map<string, { key: string; at: number; tools: AppTool[] }>();

function forgetCaches() {
  catalogCache = null;
  connectedCache = null;
  toolsCache.clear();
}

function fingerprint(apiKey: string, account?: Account | null): string {
  return createHash("sha256").update(JSON.stringify([apiKey, account?.orgId, account?.projectId, account?.userId])).digest("hex");
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
  const { apiKey, account } = await readState();
  if (!apiKey) return { apps: [] };
  const key = fingerprint(apiKey, account);
  if (catalogCache?.key === key && Date.now() - catalogCache.at < CATALOG_TTL_MS) return { apps: catalogCache.apps };
  const apps: AppCard[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${account ? API() : CATALOG_API()}/toolkits?${params}`, { headers: headers(apiKey, false, account), redirect: "error", signal: deadline(20_000) });
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

interface ToolItem {
  slug?: string;
  name?: string;
  tags?: string[];
  is_deprecated?: boolean;
}

/** An app's tools, without deprecated ones and ones Composio keeps out of MCP. Cached for ten minutes. */
export async function appTools({ slug }: { slug: string }): Promise<{ tools: AppTool[] }> {
  const { apiKey, account } = await readState();
  if (!apiKey) return { tools: [] };
  const app = canonicalSlug(slug);
  const key = fingerprint(apiKey, account);
  const cached = toolsCache.get(app);
  if (cached?.key === key && Date.now() - cached.at < CATALOG_TTL_MS) return { tools: cached.tools };
  const tools: AppTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ toolkit_slug: app, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${account ? API() : CATALOG_API()}/tools?${params}`, { headers: headers(apiKey, false, account), redirect: "error", signal: deadline(20_000) });
    if (!response.ok) throw await failure(response, `Composio tools: HTTP ${response.status}`);
    const body = (await response.json()) as { items?: ToolItem[]; next_cursor?: string | null };
    for (const item of body.items ?? []) {
      const tags = item.tags ?? [];
      if (!item.slug || item.is_deprecated || tags.includes("mcpIgnore")) continue;
      tools.push({ slug: item.slug.toUpperCase(), name: item.name?.trim() || item.slug, readOnly: tags.includes("readOnlyHint") });
    }
    const next = body.next_cursor?.trim();
    if (!next || next === cursor) break;
    cursor = next;
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  toolsCache.set(app, { key, at: Date.now(), tools });
  return { tools };
}

interface AccountItem {
  id?: string;
  status?: string;
  alias?: string | null;
  word_id?: string;
  toolkit?: { slug?: string };
  /** Holds the account's tokens too; only its display name is read. */
  data?: { displayName?: unknown };
}

/** This host's accounts, newest first. Cached briefly; `fresh` skips the cache while a sign-in is pending. */
export async function accounts({ fresh }: { fresh?: boolean } = {}): Promise<{ accounts: AppAccount[] }> {
  const { apiKey, userId, account } = await readState();
  if (!apiKey) return { accounts: [] };
  const key = fingerprint(apiKey, account);
  if (!fresh && connectedCache?.key === key && Date.now() - connectedCache.at < CONNECTED_TTL_MS) return { accounts: connectedCache.accounts };
  const found: AppAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "50", user_ids: account?.userId ?? userId, order_by: "updated_at", order_direction: "desc" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${API()}/connected_accounts?${params}`, { headers: headers(apiKey, false, account), redirect: "error", signal: deadline(15_000) });
    if (!response.ok) throw await failure(response, `Composio accounts: HTTP ${response.status}`);
    const body = (await response.json()) as { items?: AccountItem[]; next_cursor?: string | null };
    for (const item of body.items ?? []) {
      if (!item.id || !item.toolkit?.slug) continue;
      const name = typeof item.data?.displayName === "string" && item.data.displayName.trim() ? item.data.displayName.trim().slice(0, 120) : null;
      found.push({ id: item.id, slug: canonicalSlug(item.toolkit.slug), status: appStatus(item.status), alias: item.alias?.trim() || null, name, wordId: item.word_id?.trim() || null });
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

/** A Composio-hosted sign-in link for an app, with an optional alias for the new account ("work"). The user finishes in their browser; the app polls `accounts`. */
export async function connect({ slug, alias }: { slug: string; alias?: string }) {
  const name = alias?.trim();
  const link = async (current: Awaited<ReturnType<typeof session>>) =>
    fetch(`${API()}/tool_router/session/${encodeURIComponent(current.sessionId)}/link`, {
      method: "POST",
      headers: { ...current.headers, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ toolkit: canonicalSlug(slug), ...(name ? { alias: name } : {}) }),
      signal: deadline(30_000),
    });
  let current = await session();
  let response = await link(current);
  if (response.status === 404) {
    current = await session({ recreate: true });
    response = await link(current);
  }
  if (!response.ok) throw await failure(response, `Composio sign-in: HTTP ${response.status}`);
  const body = (await response.json()) as { redirect_url?: string };
  if (!body.redirect_url || !trusted(body.redirect_url)) throw new Error("Composio returned an unexpected sign-in link.");
  connectedCache = null;
  return { url: body.redirect_url };
}

/** Names an account ("work"), or clears the name with "". Aliases are unique per app. */
export async function renameAccount({ accountId, alias }: { accountId: string; alias: string }) {
  const { apiKey, account } = await readState();
  if (!apiKey) throw new Error("Connected apps aren't set up.");
  const { accounts: mine } = await accounts({ fresh: true });
  if (!mine.some((account) => account.id === accountId)) throw new Error("That account isn't connected on this host.");
  const response = await fetch(`${account ? API() : CATALOG_API()}/connected_accounts/${encodeURIComponent(accountId)}`, {
    method: "PATCH",
    headers: headers(apiKey, true, account),
    redirect: "error",
    body: JSON.stringify({ alias: alias.trim() }),
    signal: deadline(15_000),
  });
  if (!response.ok) throw await failure(response, `Composio rename: HTTP ${response.status}`);
  connectedCache = null;
  return { ok: true };
}

/** Disconnects one account after checking it belongs to this host's Composio user. */
export async function disconnect({ accountId }: { accountId: string }) {
  const { apiKey, account } = await readState();
  if (!apiKey) throw new Error("Connected apps aren't set up.");
  const { accounts: mine } = await accounts({ fresh: true });
  if (!mine.some((account) => account.id === accountId)) throw new Error("That account isn't connected on this host.");
  const response = await fetch(`${API()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, {
    method: "DELETE",
    headers: headers(apiKey, false, account),
    redirect: "error",
    signal: deadline(15_000),
  });
  if (!response.ok && response.status !== 404) throw await failure(response, `Composio disconnect: HTTP ${response.status}`);
  connectedCache = null;
  return { ok: true };
}
