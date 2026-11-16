import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { mcpOAuthCancelRpc, mcpOAuthDisconnectRpc, mcpOAuthFinishRpc, mcpOAuthStartRpc, mcpOAuthStatusRpc, type McpOAuthStatus } from "../../shared/mcp-oauth";
import { errorText } from "../native";

interface McpOAuthProps {
  serverId: string;
  /** A new sign-in can enable the server after its tools have been tested. */
  onConnected(newConnection: boolean): void;
  onDisconnected(): void;
}

/** Credentials and authorization codes stay in this mounted form, never in bot settings. */
export function McpOAuth({ serverId, onConnected, onDisconnected }: McpOAuthProps) {
  const getStatus = useRpc(mcpOAuthStatusRpc);
  const start = useRpc(mcpOAuthStartRpc);
  const finish = useRpc(mcpOAuthFinishRpc);
  const cancel = useRpc(mcpOAuthCancelRpc);
  const disconnect = useRpc(mcpOAuthDisconnectRpc);
  const [status, setStatus] = useState<McpOAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [manual, setManual] = useState(false);
  const [clientId, setClientId] = useState<string | undefined>();
  const [clientSecret, setClientSecret] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [formRevision, setFormRevision] = useState(0);
  const operation = useRef<object | null>(null);
  const refreshing = useRef<object | null>(null);
  const lifetime = useRef(0);
  const revision = useRef(0);
  const observed = useRef<McpOAuthStatus | null>(null);
  const callbacks = useRef({ onConnected, onDisconnected });
  callbacks.current = { onConnected, onDisconnected };

  const receive = (next: McpOAuthStatus) => {
    const previous = observed.current;
    observed.current = next;
    setStatus(next);
    if (next.connected) setError(null);
    if (next.connected && !previous?.connected) callbacks.current.onConnected(previous !== null);
  };

  const refresh = async () => {
    if (operation.current || refreshing.current) return;
    const own = {};
    refreshing.current = own;
    const scope = lifetime.current, request = revision.current;
    try {
      const next = await getStatus({ serverId });
      if (scope !== lifetime.current || request !== revision.current) return;
      receive(next);
      setStatusError(null);
    } catch (caught) {
      if (scope === lifetime.current && request === revision.current) setStatusError(errorText(caught));
    } finally {
      if (refreshing.current === own) refreshing.current = null;
      if (scope === lifetime.current && request === revision.current) setLoading(false);
    }
  };

  useEffect(() => {
    lifetime.current++;
    operation.current = null;
    refreshing.current = null;
    observed.current = null;
    setStatus(null);
    setLoading(true);
    setBusy(null);
    setError(null);
    setStatusError(null);
    setClientId(undefined);
    setClientSecret("");
    setCallbackUrl("");
    setFormRevision((value) => value + 1);
    void refresh();
    return () => { lifetime.current++; };
  }, [serverId, getStatus]);

  // A closed form does not poll; a completed/canceled/expired login stops polling.
  useEffect(() => {
    if (!status?.login || busy) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.login?.url, busy, getStatus, serverId]);

  const perform = async (name: string, action: () => Promise<McpOAuthStatus>, after?: (next: McpOAuthStatus) => Promise<void> | void) => {
    if (operation.current) return;
    const own = {};
    operation.current = own;
    revision.current++;
    const scope = lifetime.current;
    setBusy(name);
    setError(null);
    setStatusError(null);
    try {
      const next = await action();
      if (scope !== lifetime.current) return;
      receive(next);
      await after?.(next);
    } catch (caught) {
      if (scope === lifetime.current) setError(errorText(caught));
    } finally {
      if (operation.current === own) operation.current = null;
      if (scope === lifetime.current) { setBusy(null); setLoading(false); }
    }
  };

  const begin = () => {
    if (operation.current) return;
    const input = { serverId, ...(clientId !== undefined ? { clientId: clientId.trim() } : {}), ...(clientSecret ? { clientSecret } : {}) };
    // Clear both React state and the native uncontrolled input as soon as it is submitted.
    setClientSecret("");
    setCallbackUrl("");
    setFormRevision((value) => value + 1);
    void perform("start", () => start(input), async (next) => {
      setClientId(undefined);
      if (!next.connected) callbacks.current.onDisconnected();
      if (next.login) await openExternalUrl(next.login.url);
    });
  };
  const disabled = !!busy || loading;
  const login = status?.login;

  return <SettingsSection title="OAuth" info="Sign in through your browser. Credentials are stored on this Paseo host, separate from bot settings and exports. Reopen existing OAuth chats after reconnecting. If you change a server from header authentication to OAuth, start a new chat.">
    <SettingsCard>
      {loading ? <SettingsRow label="Checking sign-in…" /> : null}
      {status ? <SettingsRow label="Account" hint={login ? "Waiting for browser approval" : status.connected ? "Connected" : "Not connected"} /> : null}
      {error || statusError || status?.error ? <SettingsRow label="Sign-in problem" error={error ?? statusError ?? status?.error} /> : null}
      {!status && !loading ? <SettingsAction label="Check sign-in status" actionLabel="Retry" disabled={!!busy} onPress={() => void refresh()} /> : null}
      {login ? <>
        <SettingsRow label="Complete sign-in in your browser" hint={`This sign-in expires at ${new Date(login.expiresAt).toLocaleTimeString()}.`} />
        <SettingsAction label="Continue sign-in" actionLabel="Open browser" disabled={disabled} onPress={() => { setError(null); void openExternalUrl(login.url).catch((caught) => setError(errorText(caught))); }} />
        <SettingsAction label="Cancel sign-in" actionLabel={busy === "cancel" ? "Canceling…" : "Cancel"} disabled={disabled} onPress={() => void perform("cancel", () => cancel({ serverId }), () => { setCallbackUrl(""); setFormRevision((value) => value + 1); })} />
        <SettingsAction label="Signing in from another device?" hint="Use this if the browser cannot reach the callback on your Paseo host." actionLabel={manual ? "Hide" : "Show"} disabled={disabled} onPress={() => setManual((value) => !value)} />
        {manual ? <>
          <SettingsRow label="Copy the full callback URL" hint="After approving access, your browser may show an unreachable local page. Copy its entire address, including every query parameter, and paste it below. A code by itself cannot complete sign-in." />
          <SettingsInput key={`callback-${formRevision}`} label="Callback URL" initialValue={callbackUrl} placeholder="http://127.0.0.1:…/callback?code=…&state=…" disabled={disabled} onChangeText={setCallbackUrl} />
          <SettingsAction label="Finish sign-in" actionLabel={busy === "finish" ? "Finishing…" : "Finish"} disabled={disabled || !callbackUrl.trim()} onPress={() => void perform("finish", () => finish({ serverId, callbackUrl: callbackUrl.trim() }), () => { setCallbackUrl(""); setFormRevision((value) => value + 1); })} />
        </> : null}
      </> : <>
        <SettingsAction label={status?.connected ? "Reconnect account" : "Connect account"} actionLabel={busy === "start" ? "Opening…" : status?.connected ? "Reconnect" : "Connect"} disabled={disabled || !status} onPress={begin} />
        {status?.connected || status?.clientId ? <SettingsAction label="Disconnect account" hint="Removes this server's saved credentials from the host." actionLabel={busy === "disconnect" ? "Disconnecting…" : "Disconnect"} disabled={disabled} onPress={() => void perform("disconnect", () => disconnect({ serverId }), () => { callbacks.current.onDisconnected(); setClientId(undefined); setClientSecret(""); setFormRevision((value) => value + 1); })} /> : null}
        <SettingsAction label="Client registration" hint="Most servers register automatically. Configure a client only if the server requires one." actionLabel={advanced ? "Hide" : "Configure"} disabled={disabled || !status} onPress={() => setAdvanced((value) => !value)} />
        {advanced ? <>
          <SettingsInput key={`client-${status?.clientId ?? ""}`} label="Client ID" initialValue={clientId ?? status?.clientId ?? ""} placeholder="Automatic registration" hint="Leave empty for discovery and automatic registration. An HTTPS URL can identify client metadata." disabled={disabled} onChangeText={setClientId} />
          <SettingsInput key={`secret-${formRevision}`} label="Client secret" initialValue="" secureTextEntry placeholder={status?.hasClientSecret ? "Saved on host" : "Optional"} hint={status?.hasClientSecret ? "Leave blank to keep the saved secret for the same client ID." : "Only needed for a confidential client. Sent directly to the host when connecting."} disabled={disabled} onChangeText={setClientSecret} />
          <SettingsAction label="Redirect URI" hint={status?.redirectUrl || "Loading…"} actionLabel="Copy" disabled={disabled || !status?.redirectUrl} onPress={() => void copyText(status!.redirectUrl).catch((caught) => setError(errorText(caught)))} />
        </> : null}
      </>}
    </SettingsCard>
  </SettingsSection>;
}
