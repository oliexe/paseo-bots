import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpOAuth } from "../client/library/McpOAuth";
import type { McpOAuthStatus } from "../shared/mcp-oauth";

const rpc = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), finish: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), open: vi.fn(), copy: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => rpc[contract.name.split(".").at(-1) as "status"],
  openExternalUrl: rpc.open,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction", SettingsCard: "SettingsCard", SettingsInput: "SettingsInput", SettingsRow: "SettingsRow", SettingsSection: "SettingsSection", copyText: rpc.copy,
}));
vi.mock("../client/native", () => ({ errorText: (error: unknown) => error instanceof Error ? error.message : String(error) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disconnected: McpOAuthStatus = { connected: false, clientId: null, hasClientSecret: false, error: null, redirectUrl: "http://127.0.0.1:1234/callback", login: null };
const pending: McpOAuthStatus = { ...disconnected, clientId: "registered-client", login: { url: "https://example.com/authorize?state=random", expiresAt: "2027-01-01T12:00:00.000Z" } };
const connected: McpOAuthStatus = { ...pending, connected: true, login: null };
let root: ReactTestRenderer | undefined;
const field = (label: string) => root!.root.findByProps({ label });
async function press(label: string) { await act(async () => { field(label).props.onPress(); }); }
async function enter(label: string, value: string) { await act(async () => { field(label).props.onChangeText(value); }); }
async function mount(serverId = "server-1") {
  const onConnected = vi.fn(), onDisconnected = vi.fn();
  await act(async () => { root = create(<McpOAuth serverId={serverId} onConnected={onConnected} onDisconnected={onDisconnected} />); });
  return { onConnected, onDisconnected };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  rpc.status.mockResolvedValue(disconnected);
  rpc.start.mockResolvedValue(pending);
  rpc.cancel.mockResolvedValue(disconnected);
  rpc.disconnect.mockResolvedValue(disconnected);
  rpc.finish.mockResolvedValue(connected);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.useRealTimers(); });

describe("MCP OAuth settings", () => {
  it("submits manual credentials once, clears the secret, and opens the browser", async () => {
    const waiting = deferred<McpOAuthStatus>();
    rpc.start.mockReturnValueOnce(waiting.promise);
    const callbacks = await mount();
    await press("Client registration");
    await enter("Client ID", " client-1 ");
    await enter("Client secret", "private-secret");
    const connect = field("Connect account").props.onPress;
    await act(async () => { connect(); connect(); });
    expect(rpc.start).toHaveBeenCalledOnce();
    expect(rpc.start).toHaveBeenCalledWith({ serverId: "server-1", clientId: "client-1", clientSecret: "private-secret" });
    expect(field("Client secret").props.initialValue).toBe("");
    await act(async () => { waiting.resolve(pending); });
    expect(rpc.open).toHaveBeenCalledWith(pending.login!.url);
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();
    await press("Cancel sign-in");
    await press("Connect account");
    expect(rpc.start.mock.calls[1]).toEqual([{ serverId: "server-1" }]);
    expect(JSON.stringify(root!.toJSON())).not.toContain("private-secret");
  });

  it("uses an explicit empty client id for automatic registration and never reads a saved secret", async () => {
    rpc.status.mockResolvedValue({ ...connected, hasClientSecret: true });
    await mount();
    await press("Client registration");
    expect(field("Client ID").props.initialValue).toBe("registered-client");
    expect(field("Client secret").props.initialValue).toBe("");
    await enter("Client ID", "");
    await press("Reconnect account");
    expect(rpc.start).toHaveBeenCalledWith({ serverId: "server-1", clientId: "" });
  });

  it("polls only a pending sign-in and reports completion once", async () => {
    const callbacks = await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(rpc.status).toHaveBeenCalledOnce();
    await press("Connect account");
    rpc.status.mockResolvedValue(connected);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(callbacks.onConnected).toHaveBeenCalledExactlyOnceWith(true);
    expect(field("Account").props.hint).toBe("Connected");
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(rpc.status).toHaveBeenCalledTimes(2);
  });

  it("continues polling after repeated network errors while sign-in is pending", async () => {
    rpc.status.mockResolvedValueOnce(pending).mockRejectedValue(new Error("Host temporarily unavailable"));
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(rpc.status).toHaveBeenCalledTimes(3);
    expect(field("Sign-in problem").props.error).toBe("Host temporarily unavailable");
    rpc.status.mockResolvedValue(connected);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(field("Account").props.hint).toBe("Connected");
    expect(root!.root.findAllByProps({ label: "Sign-in problem" })).toHaveLength(0);
  });

  it("keeps callback validation errors visible across status polls until another attempt succeeds", async () => {
    rpc.status.mockResolvedValue(pending);
    rpc.finish.mockRejectedValueOnce(new Error("The callback does not match this sign-in."));
    await mount();
    await press("Signing in from another device?");
    await enter("Callback URL", `${disconnected.redirectUrl}?code=test&state=wrong`);
    await press("Finish sign-in");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(field("Sign-in problem").props.error).toBe("The callback does not match this sign-in.");
    expect(field("Account").props.hint).toBe("Waiting for browser approval");
    await enter("Callback URL", `${disconnected.redirectUrl}?code=test&state=correct`);
    await press("Finish sign-in");
    expect(field("Account").props.hint).toBe("Connected");
    expect(root!.root.findAllByProps({ label: "Sign-in problem" })).toHaveLength(0);
  });

  it("passes the entire callback URL to host validation and clears it on completion", async () => {
    rpc.status.mockResolvedValue(pending);
    const callbacks = await mount();
    await press("Signing in from another device?");
    const callbackUrl = `${disconnected.redirectUrl}?code=one-time-code&state=state-token&iss=https%3A%2F%2Fissuer.example`;
    await enter("Callback URL", ` ${callbackUrl} `);
    await press("Finish sign-in");
    expect(rpc.finish).toHaveBeenCalledWith({ serverId: "server-1", callbackUrl });
    expect(callbacks.onConnected).toHaveBeenCalledExactlyOnceWith(true);
    expect(root!.root.findAllByProps({ label: "Callback URL" })).toHaveLength(0);
    expect(JSON.stringify(root!.toJSON())).not.toContain("one-time-code");
  });

  it("does not let a late status poll restore a canceled login", async () => {
    const read = deferred<McpOAuthStatus>();
    rpc.status.mockResolvedValueOnce(pending).mockReturnValueOnce(read.promise);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await press("Cancel sign-in");
    await act(async () => { read.resolve(pending); });
    expect(root!.root.findAllByProps({ label: "Cancel sign-in" })).toHaveLength(0);
    expect(field("Account").props.hint).toBe("Not connected");
  });

  it("does not open a browser or test a connection after the form unmounts", async () => {
    const waiting = deferred<McpOAuthStatus>();
    rpc.start.mockReturnValueOnce(waiting.promise);
    const callbacks = await mount();
    await press("Connect account");
    await act(async () => { root!.unmount(); });
    root = undefined;
    await act(async () => { waiting.resolve(connected); });
    expect(rpc.open).not.toHaveBeenCalled();
    expect(callbacks.onConnected).not.toHaveBeenCalled();
    expect(callbacks.onDisconnected).not.toHaveBeenCalled();
  });

  it("discards a previous server's delayed response while loading the next server", async () => {
    const old = deferred<McpOAuthStatus>();
    rpc.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(disconnected);
    const callbacks = await mount();
    await act(async () => { root!.update(<McpOAuth serverId="server-2" {...callbacks} />); });
    await act(async () => { old.resolve(connected); });
    expect(rpc.status.mock.calls).toEqual([[{ serverId: "server-1" }], [{ serverId: "server-2" }]]);
    expect(field("Account").props.hint).toBe("Not connected");
    expect(callbacks.onConnected).not.toHaveBeenCalled();
  });

  it("keeps a failed browser open recoverable and disconnects with no credentials in settings", async () => {
    rpc.open.mockRejectedValueOnce(new Error("Browser could not open"));
    await mount();
    await press("Connect account");
    expect(field("Sign-in problem").props.error).toBe("Browser could not open");
    expect(field("Continue sign-in").props.disabled).toBe(false);
    await press("Cancel sign-in");
    rpc.status.mockResolvedValue(connected);
    await act(async () => { root!.unmount(); });
    root = undefined;
    const callbacks = await mount();
    await press("Disconnect account");
    expect(rpc.disconnect).toHaveBeenCalledWith({ serverId: "server-1" });
    expect(field("Account").props.hint).toBe("Not connected");
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();
  });
});
