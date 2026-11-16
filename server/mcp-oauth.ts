import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformationSchema, OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { LibraryMcpServer, McpServerConfig } from "../shared/bot";
import type { McpOAuthStatus } from "../shared/mcp-oauth";
import { PLUGIN_VERSION } from "../shared/version";
import { pluginDataPath } from "./bot-home";
import { atomicWrite, ensureRealDirectory, readRegularText } from "./files";
import type { BotsHost } from "./host";
import { oauthFetch, validateOAuthUrl } from "./mcp-oauth-network";

type RemoteConfig = Exclude<McpServerConfig, { type: "stdio" }>;
const MAX_STORE_BYTES = 1024 * 1024;
const LOGIN_MS = 10 * 60_000;
const DiscoverySchema = z.object({
  authorizationServerUrl: z.string(),
  resourceMetadataUrl: z.string().optional(),
  resourceMetadata: OAuthProtectedResourceMetadataSchema,
  authorizationServerMetadata: OAuthMetadataSchema,
});
const EntrySchema = z.object({
  fingerprint: z.string(), generation: z.string(),
  client: OAuthClientInformationSchema.optional(), manual: z.boolean().default(false),
  discovery: DiscoverySchema.optional(),
  tokens: OAuthTokensSchema.optional(), expiresAt: z.number().nullable().default(null),
  redirectUrl: z.string().optional(), error: z.string().nullable().default(null),
});
type Entry = z.infer<typeof EntrySchema>;
const StoreSchema = z.object({ secret: z.string().min(64), entries: z.record(z.string(), EntrySchema) });
type Store = z.infer<typeof StoreSchema>;
interface Login { state: string; verifier?: string; url?: string; expiresAt: number; redirectUrl: string; fingerprint: string; issuer?: string; requireIssuer?: boolean; used: boolean }
export class OAuthNotice extends Error {}

function fingerprint(config: RemoteConfig): string {
  return createHash("sha256").update(JSON.stringify([config.type, config.url, Object.entries(config.headers).sort()])).digest("hex");
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function publicError(error: unknown): string {
  if (error instanceof OAuthNotice) return error.message;
  // OAuth servers can echo submitted credentials in error bodies. Never relay those bodies to clients/logs.
  const name = error instanceof Error ? error.constructor.name : "";
  if (name === "InvalidClientError" || name === "UnauthorizedClientError") return "The OAuth server rejected this client. Check its client ID, secret and registered redirect URL.";
  if (name === "InvalidGrantError") return "This authorization has expired or was revoked. Connect again.";
  return "The OAuth server could not complete the request. Check its OAuth metadata and client registration, then try again.";
}

/** Host-only OAuth credentials; no token or client secret is returned by an RPC or saved in bot settings. */
export class McpOAuth {
  private readonly file = join(pluginDataPath(), "mcp-oauth.json");
  private storeQueue: Promise<unknown> = Promise.resolve();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly logins = new Map<string, Login>();
  private readonly invalidated = new Set<(id: string) => void>();
  private stopped = false;
  private pendingPort: Promise<number> | null = null;

  constructor(private readonly host: BotsHost, private readonly port: () => Promise<number>) {}

  onInvalidate(listener: (id: string) => void): () => void { this.invalidated.add(listener); return () => { this.invalidated.delete(listener); }; }
  private invalidate(id: string): void { for (const listener of this.invalidated) listener(id); }

  private async read(): Promise<Store> {
    await ensureRealDirectory(pluginDataPath());
    const text = await readRegularText(this.file, MAX_STORE_BYTES);
    return text === null ? { secret: randomBytes(32).toString("hex"), entries: {} } : StoreSchema.parse(JSON.parse(text));
  }

  private change<T>(fn: (store: Store) => T): Promise<T> {
    const next = this.storeQueue.catch(() => {}).then(async () => {
      const store = await this.read();
      const result = fn(store);
      const text = JSON.stringify(store);
      if (Buffer.byteLength(text) > MAX_STORE_BYTES || Object.keys(store.entries).length > 200) throw new OAuthNotice("Too many saved OAuth connections. Disconnect an unused server before adding another.");
      await atomicWrite(this.file, text);
      return result;
    });
    this.storeQueue = next;
    return next;
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.stopped) throw new OAuthNotice("The plugin is stopping. Reopen Bots and try again.");
      const controller = new AbortController(); this.controllers.set(id, controller);
      try { return await action(); } finally { if (this.controllers.get(id) === controller) this.controllers.delete(id); }
    });
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => {});
    return next;
  }

  async server(id: string): Promise<LibraryMcpServer & { config: RemoteConfig }> {
    const values = await this.host.values();
    if (!values) throw new OAuthNotice("Bot settings are unavailable. Try again when they have loaded.");
    const server = values.library?.mcpServers.find((entry) => entry.id === id);
    if (!server || server.config.type === "stdio" || !server.config.oauth) throw new OAuthNotice("This server no longer has OAuth enabled.");
    // Settings are authoritative. Removed/changed connections cannot use an older credential.
    return server as LibraryMcpServer & { config: RemoteConfig };
  }

  private async entry(id: string, config: RemoteConfig): Promise<Entry> {
    const hash = fingerprint(config);
    const values = await this.host.values();
    if (!values) throw new OAuthNotice("Bot settings are unavailable. Try again when they have loaded.");
    const retained = new Set((values.library?.mcpServers ?? []).filter((server) => server.config.type !== "stdio" && server.config.oauth).map((server) => server.id));
    return this.change((store) => {
      for (const savedId of Object.keys(store.entries)) if (!retained.has(savedId)) { delete store.entries[savedId]; this.logins.delete(savedId); this.invalidate(savedId); }
      const current = store.entries[id];
      if (current?.fingerprint === hash) return current;
      if (current) this.invalidate(id);
      const next: Entry = { fingerprint: hash, generation: randomBytes(32).toString("hex"), manual: false, expiresAt: null, error: null };
      store.entries[id] = next;
      this.logins.delete(id);
      return next;
    });
  }

  private save(id: string, entry: Entry, live?: () => boolean): Promise<void> {
    return this.change((store) => {
      if (live && !live()) throw new OAuthNotice("Sign-in was canceled.");
      if (store.entries[id]?.generation !== entry.generation || store.entries[id]?.fingerprint !== entry.fingerprint) throw new OAuthNotice("This OAuth connection changed. Connect again.");
      store.entries[id] = entry;
    });
  }

  private async redirectUrl(): Promise<string> {
    if (this.stopped) throw new OAuthNotice("The plugin is stopping. Reopen Bots and try again.");
    const pending = this.pendingPort = this.port();
    const port = await pending;
    if (this.pendingPort === pending) this.pendingPort = null;
    if (this.stopped) throw new OAuthNotice("The plugin is stopping. Reopen Bots and try again.");
    return `http://127.0.0.1:${port}/mcp-oauth/callback`;
  }

  async status(id: string): Promise<McpOAuthStatus> {
    const server = await this.server(id);
    const saved = (await this.read()).entries[id];
    const entry = saved?.fingerprint === fingerprint(server.config) ? saved : undefined;
    if (saved && !entry) this.invalidate(id);
    let login = this.logins.get(id);
    if (login && (login.expiresAt <= Date.now() || login.fingerprint !== fingerprint(server.config))) { this.logins.delete(id); login = undefined; }
    return {
      connected: !!entry?.tokens && (entry.expiresAt === null || entry.expiresAt > Date.now() || !!entry.tokens.refresh_token),
      clientId: entry?.client?.client_id ?? null, hasClientSecret: !!entry?.client?.client_secret,
      error: entry?.error ?? null, redirectUrl: await this.redirectUrl(),
      login: login?.url ? { url: login.url, expiresAt: new Date(login.expiresAt).toISOString() } : null,
    };
  }

  /** Validate SDK discovery before it may register a client, exchange codes or refresh tokens. */
  private async validateDiscovery(value: OAuthDiscoveryState, config: RemoteConfig, signal?: AbortSignal): Promise<Entry["discovery"] & {}> {
    const parsed = DiscoverySchema.safeParse(value);
    if (!parsed.success) throw new OAuthNotice("The server must publish OAuth protected-resource and authorization-server metadata.");
    const state = parsed.data;
    if (state.authorizationServerMetadata.issuer !== state.authorizationServerUrl) throw new OAuthNotice("The authorization server's issuer does not match its discovery URL.");
    if (!state.resourceMetadata.authorization_servers?.includes(state.authorizationServerUrl)) throw new OAuthNotice("The resource metadata does not authorize this OAuth issuer.");
    if (!state.authorizationServerMetadata.code_challenge_methods_supported?.includes("S256")) throw new OAuthNotice("The OAuth server must support PKCE with S256.");
    for (const url of [state.authorizationServerUrl, state.authorizationServerMetadata.authorization_endpoint, state.authorizationServerMetadata.token_endpoint, state.authorizationServerMetadata.registration_endpoint].filter((url): url is string => !!url)) await validateOAuthUrl(url, config.url, signal);
    return state;
  }

  private provider(id: string, entry: Entry, config: RemoteConfig, login?: Login): { provider: OAuthClientProvider; fetch: FetchLike } {
    const fetch = oauthFetch(config.url);
    const controller = this.controllers.get(id)!;
    const live = () => !this.stopped && !controller.signal.aborted && (!login || this.logins.get(id) === login);
    const check = () => { if (!live()) throw new OAuthNotice("Sign-in was canceled."); };
    const persist = () => this.save(id, entry, live);
    const rawMetadata = new Map<string, Record<string, unknown>>();
    const wrapped: FetchLike = async (input, init) => {
      check();
      const response = await fetch(input, { ...init, signal: controller.signal });
      check();
      if (response.ok && (response.headers.get("content-type") ?? "").includes("json")) {
        const value = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
        if (value && typeof value.issuer === "string" && typeof value.token_endpoint === "string") rawMetadata.set(value.issuer, value);
      }
      return response;
    };
    const provider: OAuthClientProvider = {
      redirectUrl: login?.redirectUrl ?? entry.redirectUrl,
      clientMetadata: {
        client_name: "Paseo Bots", redirect_uris: [login?.redirectUrl ?? entry.redirectUrl!],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: entry.client?.client_secret ? "client_secret_basic" : "none",
        ...({ application_type: "native" } as object),
      },
      state: () => {
        if (!login) throw new OAuthNotice("Connect this MCP server again to continue.");
        return login.state;
      },
      clientInformation: () => entry.client,
      saveClientInformation: async (client) => { check(); entry.client = client; await persist(); },
      tokens: () => entry.tokens,
      saveTokens: async (tokens) => {
        check();
        if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.access_token || /[\r\n]/.test(tokens.access_token)) throw new OAuthNotice("The OAuth server returned an unsupported access token.");
        entry.tokens = { ...tokens, ...(tokens.refresh_token || !entry.tokens?.refresh_token ? {} : { refresh_token: entry.tokens.refresh_token }) };
        entry.expiresAt = tokens.expires_in === undefined ? null : Date.now() + Math.max(0, tokens.expires_in) * 1000;
        entry.error = null;
        await persist();
      },
      redirectToAuthorization: async (url) => {
        if (!login) throw new OAuthNotice("Connect this MCP server again to continue.");
        check(); await validateOAuthUrl(url, config.url, controller.signal); check();
        login.url = url.href;
      },
      saveCodeVerifier: (verifier) => { if (!login) throw new OAuthNotice("Connect this MCP server again to continue."); login.verifier = verifier; },
      codeVerifier: () => { if (!login?.verifier) throw new OAuthNotice("This sign-in has expired. Connect again."); return login.verifier; },
      discoveryState: async () => { check(); return entry.discovery ? this.validateDiscovery(entry.discovery, config, controller.signal) : undefined; },
      saveDiscoveryState: async (state) => {
        const raw = rawMetadata.get(state.authorizationServerUrl);
        if (raw && state.authorizationServerMetadata) state.authorizationServerMetadata = { ...state.authorizationServerMetadata, authorization_response_iss_parameter_supported: raw.authorization_response_iss_parameter_supported };
        check(); const discovery = await this.validateDiscovery(state, config, controller.signal); check();
        if (entry.client?.issuer && entry.client.issuer !== discovery.authorizationServerUrl) {
          if (entry.manual) throw new OAuthNotice("This saved client belongs to another authorization server. Enter its replacement client ID or disconnect first.");
          delete entry.client; delete entry.tokens;
        }
        if (entry.client && !entry.client.issuer) entry.client.issuer = discovery.authorizationServerUrl;
        entry.discovery = discovery;
        if (login) {
          login.issuer = discovery.authorizationServerUrl;
          login.requireIssuer = discovery.authorizationServerMetadata.authorization_response_iss_parameter_supported === true;
        }
        await persist();
      },
      invalidateCredentials: async (scope) => {
        check();
        if (scope === "all" || scope === "tokens") { delete entry.tokens; entry.expiresAt = null; }
        if ((scope === "all" || scope === "client") && !entry.manual) delete entry.client;
        if (scope === "all" || scope === "discovery") delete entry.discovery;
        if (scope === "all" || scope === "verifier") { if (login) delete login.verifier; }
        await persist();
        // SDK auth() retries InvalidGrant/InvalidClient with the same code. A callback code is single-use.
        if (login?.used) throw new OAuthNotice("The authorization code was rejected. Connect again to start a fresh sign-in.");
      },
    };
    return { provider, fetch: wrapped };
  }

  async start(id: string, input: { clientId?: string; clientSecret?: string } = {}): Promise<McpOAuthStatus> {
    return this.serial(id, async () => {
      const { config } = await this.server(id);
      const entry = await this.entry(id, config);
      const redirectUrl = await this.redirectUrl();
      if (!entry.manual && entry.redirectUrl && entry.redirectUrl !== redirectUrl) delete entry.client;
      if (input.clientId !== undefined) {
        const clientId = input.clientId.trim();
        if (!clientId) { delete entry.client; entry.manual = false; }
        else {
          entry.client = { client_id: clientId, ...(entry.client?.client_id === clientId ? entry.client : {}), ...(input.clientSecret === undefined ? {} : { client_secret: input.clientSecret }) };
          entry.manual = true;
        }
      }
      if (input.clientSecret !== undefined && entry.client) {
        if (input.clientSecret) entry.client.client_secret = input.clientSecret; else delete entry.client.client_secret;
      }
      delete entry.tokens; delete entry.discovery;
      this.invalidate(id);
      entry.expiresAt = null; entry.error = null; entry.redirectUrl = redirectUrl;
      await this.save(id, entry);
      const login: Login = { state: randomBytes(32).toString("base64url"), expiresAt: Date.now() + LOGIN_MS, redirectUrl, fingerprint: entry.fingerprint, used: false };
      this.logins.set(id, login);
      try {
        const { provider, fetch } = this.provider(id, entry, config, login);
        // Get the resource's challenge first; its metadata URL and scopes take precedence over well-known discovery.
        const headers = new Headers(config.headers);
        headers.delete("authorization"); headers.delete("cookie"); headers.delete("host");
        headers.set("Accept", "application/json, text/event-stream"); headers.set("Content-Type", "application/json");
        const challenge = await oauthFetch(config.url, { headersOnly: true })(config.url, { method: config.type === "sse" ? "GET" : "POST", signal: this.controllers.get(id)!.signal, headers, ...(config.type === "http" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "paseo-bots", version: PLUGIN_VERSION } } }) } : {}) });
        const hints = extractWWWAuthenticateParams(challenge);
        await challenge.body?.cancel();
        await auth(provider, { serverUrl: config.url, fetchFn: fetch, ...hints });
        if (this.stopped) throw new OAuthNotice("Sign-in was canceled because the plugin stopped.");
      } catch (error) {
        this.logins.delete(id); entry.error = publicError(error);
        if (!this.controllers.get(id)?.signal.aborted && !this.stopped) await this.save(id, entry);
      }
      return this.status(id);
    });
  }

  async finish(id: string, callbackUrl: string): Promise<McpOAuthStatus> {
    return this.serial(id, async () => {
      const { config } = await this.server(id);
      const entry = await this.entry(id, config);
      const login = this.logins.get(id);
      if (!login || login.used || login.expiresAt <= Date.now() || login.fingerprint !== entry.fingerprint) throw new OAuthNotice("This sign-in has expired or was already used. Connect again.");
      const url = new URL(callbackUrl);
      const expected = new URL(login.redirectUrl);
      if (!callbackUrl.startsWith(`${login.redirectUrl}?`) || url.origin !== expected.origin || url.pathname !== expected.pathname || callbackUrl.includes("#") || url.username || url.password) throw new OAuthNotice("Paste the complete callback URL from this sign-in, beginning with its exact localhost address.");
      if (url.searchParams.getAll("state").length !== 1 || !equal(url.searchParams.get("state") ?? "", login.state)) throw new OAuthNotice("The callback does not match this sign-in. Return to the browser opened by Connect.");
      const issuer = url.searchParams.get("iss");
      if (url.searchParams.getAll("iss").length > 1 || (login.requireIssuer && !issuer) || (issuer !== null && issuer !== login.issuer)) throw new OAuthNotice("The callback's authorization-server issuer does not match this sign-in.");
      // A callback is single-use, including a failed token exchange. Never replay an authorization code.
      login.used = true;
      try {
        if (url.searchParams.has("error")) throw new OAuthNotice("Authorization was declined or canceled in the browser. Connect again when ready.");
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.getAll("code").length !== 1) throw new OAuthNotice("The callback has no authorization code. Connect again.");
        const { provider, fetch } = this.provider(id, entry, config, login);
        if (await auth(provider, { serverUrl: config.url, authorizationCode: code, fetchFn: fetch }) !== "AUTHORIZED") throw new OAuthNotice("Authorization was not completed. Connect again.");
      } catch (error) { entry.error = publicError(error); delete entry.tokens; if (!this.controllers.get(id)?.signal.aborted && !this.stopped) await this.save(id, entry); }
      finally { this.logins.delete(id); }
      return this.status(id);
    });
  }

  /** Callback requests carry only a random state; IDs and tokens never appear in browser URLs. */
  async callback(url: string): Promise<void> {
    const state = new URL(url).searchParams.get("state");
    const found = [...this.logins].find(([, login]) => state && equal(state, login.state));
    if (!found) throw new OAuthNotice("This sign-in is no longer active. Return to Paseo and connect again.");
    const result = await this.finish(found[0], url);
    if (!result.connected) throw new OAuthNotice(result.error ?? "Sign-in was not completed.");
  }

  async cancel(id: string): Promise<McpOAuthStatus> {
    // Mark consumed synchronously so a queued callback cannot revive a canceled login.
    const login = this.logins.get(id); if (login) login.used = true;
    this.logins.delete(id);
    this.controllers.get(id)?.abort();
    return this.serial(id, async () => { this.logins.delete(id); return this.status(id); });
  }

  async disconnect(id: string): Promise<McpOAuthStatus> {
    const login = this.logins.get(id); if (login) login.used = true;
    this.logins.delete(id);
    this.controllers.get(id)?.abort();
    this.invalidate(id);
    return this.serial(id, async () => {
      this.logins.delete(id);
      await this.change((store) => { delete store.entries[id]; });
      return this.status(id);
    });
  }

  /** Called only by the loopback proxy/probe, never by the app. Parallel requests share one refresh. */
  accessToken(id: string, rejectedToken?: string, expectedConfig?: RemoteConfig): Promise<string> {
    return this.serial(id, async () => {
      const { config } = await this.server(id);
      if (expectedConfig && fingerprint(expectedConfig) !== fingerprint(config)) throw new OAuthNotice("This MCP connection changed. Reopen the chat before using it.");
      const entry = await this.entry(id, config);
      if (!entry.tokens) throw new OAuthNotice("Connect this MCP server in Skills & Tools before using it.");
      if (rejectedToken && rejectedToken !== entry.tokens.access_token) return entry.tokens.access_token;
      if (!rejectedToken && (entry.expiresAt === null || entry.expiresAt > Date.now() + 1_000)) return entry.tokens.access_token;
      if (!entry.tokens.refresh_token) throw new OAuthNotice("This MCP authorization has expired. Reconnect it in Skills & Tools.");
      try {
        const { provider, fetch } = this.provider(id, entry, config);
        if (await auth(provider, { serverUrl: config.url, fetchFn: fetch }) !== "AUTHORIZED" || !entry.tokens) throw new OAuthNotice("Reconnect this MCP server in Skills & Tools.");
        return entry.tokens.access_token;
      } catch (error) {
        entry.error = publicError(error);
        if (!this.controllers.get(id)?.signal.aborted && !this.stopped) await this.save(id, entry);
        throw new OAuthNotice(entry.error);
      }
    });
  }

  async proxyToken(id: string, subject: string, expectedConfig?: RemoteConfig): Promise<string> {
    const { config } = await this.server(id);
    if (expectedConfig && fingerprint(expectedConfig) !== fingerprint(config)) throw new OAuthNotice("This MCP connection changed. Reopen the chat before using it.");
    const entry = await this.entry(id, config);
    const store = await this.read();
    return createHmac("sha256", store.secret).update(JSON.stringify([id, subject, entry.fingerprint, entry.generation])).digest("hex");
  }

  /** Derive an SSE endpoint credential without creating or rotating its parent connection. */
  async proxyEndpointToken(id: string, subject: string, endpoint: string, header: string | undefined, expectedConfig: RemoteConfig): Promise<string> {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "")?.[1];
    const { config } = await this.server(id);
    if (!supplied || fingerprint(expectedConfig) !== fingerprint(config)) throw new OAuthNotice("This MCP connection changed.");
    const store = await this.read(); const entry = store.entries[id];
    if (!entry || entry.fingerprint !== fingerprint(config)) throw new OAuthNotice("This MCP connection changed.");
    const sign = (value: string) => createHmac("sha256", store.secret).update(JSON.stringify([id, value, entry.fingerprint, entry.generation])).digest("hex");
    if (!equal(supplied, sign(subject))) throw new OAuthNotice("This MCP connection changed.");
    return sign(`${subject}:${endpoint}`);
  }

  async verifyProxyToken(id: string, subject: string, header: string | undefined): Promise<boolean> {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "")?.[1];
    if (!supplied) return false;
    const { config } = await this.server(id);
    const store = await this.read(); const entry = store.entries[id];
    if (!entry || entry.fingerprint !== fingerprint(config)) return false;
    const expected = createHmac("sha256", store.secret).update(JSON.stringify([id, subject, entry.fingerprint, entry.generation])).digest("hex");
    return equal(supplied, expected);
  }

  async stop(): Promise<void> {
    this.stopped = true; this.logins.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.operations.values()]);
    await this.storeQueue.catch(() => {});
    await this.pendingPort?.catch(() => {});
  }
}
