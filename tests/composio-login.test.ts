import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let composio: typeof import("../server/composio");
let approved = false;
let expired = false;
let rejectSession = false;
let expireAfter = 60_000;
let route: (url: URL, init: RequestInit) => Response | Promise<Response>;
let requests: { url: URL; init: RequestInit }[];
const key = "uak_private_credential";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const auth = { "x-user-api-key": key, "x-org-id": "org_personal", "x-project-id": "proj_personal" };

beforeEach(async () => {
  const root = process.env.HS_TEMP || join(homedir(), "Temp");
  await mkdir(root, { recursive: true });
  home = await mkdtemp(join(root, "bots-login-test-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.resetModules();
  composio = await import("../server/composio");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  approved = false;
  expired = false;
  rejectSession = false;
  expireAfter = 60_000;
  requests = [];
  route = (url, init) => {
    switch (url.pathname) {
      case "/api/v3.1/cli/create-session":
        expect(JSON.parse(init.body as string)).toEqual({ scope: "user" });
        return json({ id: "session-private", code: "ABC123", expiresAt: new Date(Date.now() + expireAfter).toISOString() });
      case "/api/v3.1/cli/get-session":
        expect(url.searchParams.get("id")).toBe("session-private");
        return json({ status: expired ? "expired" : approved ? "linked" : "pending", api_key: approved ? key : null });
      case "/api/v3.1/auth/session/info":
        expect(init.headers).toEqual({ "x-user-api-key": key });
        return json({ project: { org: { id: "org_personal", name: "Personal" } }, org_member: { email: "me@example.com" } });
      case "/api/v3.1/org/consumer/project/resolve":
        expect(init.headers).toEqual({ "x-user-api-key": key, "x-org-id": "org_personal" });
        return json({ project_nano_id: "proj_personal", consumer_user_id: "consumer_me" });
      case "/api/v3.1/tool_router/session":
        expect(init.headers).toEqual({ ...auth, "content-type": "application/json" });
        expect(JSON.parse(init.body as string)).toMatchObject({ user_id: "consumer_me", multi_account: { enable: true } });
        return rejectSession ? json({ message: key }, 403) : json({ session_id: "trs_personal", mcp: { url: "https://backend.composio.dev/mcp/personal" } });
      case "/api/v3.1/toolkits":
        expect(init.headers).toEqual(auth);
        return json({ items: [{ slug: "gmail", name: "Gmail" }] });
      case "/api/v3.1/tools":
        expect(init.headers).toEqual(auth);
        return json({ items: [{ slug: "GMAIL_FETCH_EMAILS", name: "Fetch", tags: ["readOnlyHint"] }] });
      case "/api/v3.1/connected_accounts":
        expect(init.headers).toEqual(auth);
        expect(url.searchParams.get("user_ids")).toBe("consumer_me");
        return json({ items: [{ id: "ca_me", toolkit: { slug: "gmail" }, status: "ACTIVE" }] });
      case "/api/v3.1/tool_router/session/trs_personal/link":
        expect(init.headers).toEqual({ ...auth, "content-type": "application/json" });
        return json({ redirect_url: "https://backend.composio.dev/link/gmail" });
      default:
        throw new Error(`Unexpected request: ${url.pathname}`);
    }
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://backend.composio.dev");
    expect(init.redirect).toBe("error");
    requests.push({ url, init });
    return route(url, init);
  }));
});

afterEach(async () => {
  composio.cancelLogin();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("Composio browser sign-in", () => {
  it("waits for approval, stores credentials privately and scopes app requests to the personal account", async () => {
    const login = await composio.startLogin();
    expect(login).toMatchObject({ url: "https://dashboard.composio.dev/?cliKey=session-private", code: "ABC123" });
    expect(await composio.startLogin()).toEqual(login);
    expect(requests.filter(({ url }) => url.pathname.endsWith("create-session"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await composio.status()).configured).toBe(false);
    approved = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(async () => expect((await composio.status()).login).toBeNull());
    const status = await composio.status();
    expect(status).toEqual({ configured: true, keyHint: null, account: { email: "me@example.com", organization: "Personal" }, login: null, loginError: null });
    expect(JSON.stringify(status)).not.toContain(key);
    const file = join(home, "plugin-data", "paseo-bots", "composio.json");
    expect(JSON.parse(await readFile(file, "utf8")).apiKey).toBe(key);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect((await composio.session()).headers).toEqual(auth);
    await composio.session({ recreate: true });
    expect((await composio.catalog()).apps[0]?.slug).toBe("gmail");
    expect((await composio.accounts()).accounts[0]?.id).toBe("ca_me");
    expect((await composio.appTools({ slug: "gmail" })).tools[0]?.readOnly).toBe(true);
    expect(await composio.connect({ slug: "gmail" })).toEqual({ url: "https://backend.composio.dev/link/gmail" });
    const legacyUser = (await composio.readState()).userId;
    await composio.removeKey();
    expect(await composio.status()).toMatchObject({ configured: false, account: null, login: null });
    expect((await composio.readState()).userId).toBe(legacyUser);
    await expect(composio.session()).rejects.toThrow("Sign in to Composio");
  });

  it("cancels a login while its approval response is in flight", async () => {
    const original = route;
    let release!: (response: Response) => void;
    route = (url, init) => url.pathname.endsWith("get-session") ? new Promise<Response>((resolve) => { release = resolve; }) : original(url, init);
    await composio.startLogin();
    await vi.advanceTimersByTimeAsync(3_000);
    composio.cancelLogin();
    release(json({ status: "linked", api_key: key }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await composio.status()).toMatchObject({ configured: false, login: null });
    expect(requests.some(({ url }) => url.pathname.endsWith("session/info"))).toBe(false);
  });

  it("expires pending sign-in without leaving a polling timer", async () => {
    expireAfter = 1_000;
    await composio.startLogin();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await composio.status()).toMatchObject({ configured: false, login: null, loginError: expect.stringContaining("expired") });
    const count = requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(count);
  });

  it("reports rejected approval and allows retry", async () => {
    expired = true;
    await composio.startLogin();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await composio.status()).toMatchObject({ configured: false, login: null, loginError: expect.any(String) });
    expired = false;
    approved = true;
    await composio.startLogin();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(async () => expect((await composio.status()).login).toBeNull());
    expect((await composio.status()).configured).toBe(true);
  });

  it("keeps a working legacy configuration when personal-session creation fails and never exposes returned credentials", async () => {
    await composio.writeState({ apiKey: "ak_legacy", sessionId: "trs_legacy", mcpUrl: "https://backend.composio.dev/mcp/legacy", multiAccount: true });
    approved = true;
    rejectSession = true;
    await composio.startLogin();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(async () => expect((await composio.status()).login).toBeNull());
    const status = await composio.status();
    expect(status).toMatchObject({ configured: true, account: null, loginError: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(key);
    expect((await composio.session()).headers).toEqual({ "x-api-key": "ak_legacy" });
  });

  it("shares a concurrent start request and discards it if canceled before the response arrives", async () => {
    const original = route;
    let release!: (response: Response) => void;
    route = (url, init) => url.pathname.endsWith("create-session") ? new Promise<Response>((resolve) => { release = resolve; }) : original(url, init);
    const first = composio.startLogin();
    const second = composio.startLogin();
    const outcomes = Promise.allSettled([first, second]);
    expect(requests).toHaveLength(1);
    composio.cancelLogin();
    release(json({ id: "discarded", code: "ABC123", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(await composio.status()).toMatchObject({ configured: false, login: null });
    expect(requests).toHaveLength(1);
  });

});
