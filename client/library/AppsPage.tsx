import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { matchesQuery } from "../../shared/library";
import { appsRemoveKeyRpc, appsLoginRpc, appsCancelLoginRpc } from "../../shared/rpc";
import { Button, CardNote, RowText, SearchField, SectionMeta, StatusBadge } from "../panel/controls";
import { useAppsAccounts, useAppsCatalog, useAppsInvalidate, useAppsStatus } from "./apps";
import { AppLogo, DangerZone, PageTitle } from "./parts";
import { errorText } from "../native";

type Colors = PluginTheme["colors"];

/** Rows rendered at once; the catalog runs past a thousand apps, so search narrows it. */
const SHOWN = 50;

interface AppsPageProps {
  colors: Colors;
  showTitle: boolean;
  /** App whose sign-in is open in the browser. */
  pending: string | null;
  onConnect(slug: string): void;
}

/** Composio setup, then the app catalog with a Connect button per app. */
export function AppsPage({ colors, showTitle, pending, onConnect }: AppsPageProps) {
  const status = useAppsStatus();
  const configured = status.data?.configured ?? false;
  const invalidate = useAppsInvalidate();
  const email = status.data?.account?.email;
  const organization = status.data?.account?.organization;
  useEffect(() => {
    if (configured) void invalidate();
  }, [configured, email, organization]);
  return (
    <>
      {showTitle ? <PageTitle colors={colors} title="Connected apps" /> : null}
      {status.isError ? <SettingsRow label="Couldn't load Composio status" error={errorText(status.error)} /> : null}
      {status.isLoading ? <CardNote colors={colors} loading text="Loading..." /> : configured ? <Catalog colors={colors} pending={pending} onConnect={onConnect} accountLabel={status.data?.account ? `${status.data.account.email} · ${status.data.account.organization}` : null} /> : <Setup colors={colors} />}
    </>
  );
}

function Setup({ colors, legacy = false }: { colors: Colors; legacy?: boolean }) {
  const startLogin = useRpc(appsLoginRpc);
  const cancelLogin = useRpc(appsCancelLoginRpc);
  const status = useAppsStatus();
  const invalidate = useAppsInvalidate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = status.data?.login;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startLogin({});
      await invalidate();
      await openExternalUrl(next.url);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelLogin({});
      await invalidate();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Composio"
      info={legacy
        ? "This host uses a saved project key. Sign in to switch to your personal Composio account and its apps. Existing project connections stay in their original project."
        : "Sign in to your Composio account in your browser, then choose which apps your bots can use. Your credentials stay on this host."}
    >
      <SettingsCard>
        {login ? (
          <>
            <SettingsRow label="Waiting for Composio approval" hint={`Check that the browser shows code ${login.code}. Sign-in expires at ${new Date(login.expiresAt).toLocaleTimeString()}.`} />
            <SettingsAction label="Continue sign-in" actionLabel="Open browser" onPress={() => void openExternalUrl(login.url).catch((caught) => setError(errorText(caught)))} />
            <SettingsAction label="Cancel sign-in" actionLabel="Cancel" disabled={busy} onPress={() => void cancel()} />
          </>
        ) : (
          <SettingsAction label="Sign in to Composio" hint="Approve access in your browser" actionLabel={busy ? "Opening..." : "Sign in"} disabled={busy} onPress={() => void start()} />
        )}
        {error || status.data?.loginError ? <SettingsRow label="Couldn't sign in" error={error ?? status.data?.loginError ?? undefined} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function Catalog({ colors, pending, onConnect, accountLabel }: { colors: Colors; pending: string | null; onConnect(slug: string): void; accountLabel: string | null }) {
  const catalog = useAppsCatalog(true);
  const accounts = useAppsAccounts(true, pending !== null);
  const removeKey = useRpc(appsRemoveKeyRpc);
  const invalidate = useAppsInvalidate();
  const [query, setQuery] = useState("");
  const apps = catalog.data?.apps ?? [];
  const connected = new Set((accounts.data?.accounts ?? []).filter((account) => account.status === "connected").map((account) => account.slug));
  const matches = apps.filter((app) => matchesQuery(query, app.name, app.slug, app.description));
  const shown = matches.slice(0, SHOWN);

  return (
    <>
      {!accountLabel ? <Setup colors={colors} legacy /> : null}
      <View style={{ marginBottom: 12 }}>
        <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search apps" />
      </View>
      <SettingsSection title="Apps" trailing={apps.length ? <SectionMeta colors={colors} text={`${apps.length.toLocaleString()} apps`} /> : undefined}>
        <SettingsCard>
          {catalog.isLoading ? <CardNote colors={colors} loading text="Loading apps..." /> : null}
          {catalog.isError ? <SettingsRow label="Couldn't load the apps" error={catalog.error instanceof Error ? catalog.error.message : String(catalog.error)} /> : null}
          {!catalog.isLoading && !catalog.isError && matches.length === 0 ? <CardNote colors={colors} text={query.trim() ? `No apps match "${query.trim()}"` : "No apps"} /> : null}
          {shown.map((app) => (
            <View key={app.slug} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56 }}>
              <AppLogo colors={colors} app={app} />
              <RowText colors={colors} label={app.name} hint={app.description || null} hintLines={1} />
              {connected.has(app.slug) ? (
                <StatusBadge colors={colors} label="Connected" variant="success" />
              ) : (
                <Button colors={colors} variant="outline" label={pending === app.slug ? "Waiting..." : "Connect"} loading={pending === app.slug} disabled={pending !== null && pending !== app.slug} onPress={() => onConnect(app.slug)} />
              )}
            </View>
          ))}
          {matches.length > SHOWN ? <CardNote colors={colors} text={`Showing ${SHOWN} of ${matches.length.toLocaleString()}. Search to find more.`} /> : null}
        </SettingsCard>
      </SettingsSection>
      <DangerZone
        label="Composio account"
        hint={accountLabel ?? "Connected with a saved project key"}
        actionLabel="Sign out"
        confirmTitle="Sign out of Composio?"
        confirmMessage="Bots lose access to connected apps on this host until you sign in again. Your app connections stay in Composio."
        onConfirm={() => void removeKey({}).then(invalidate)}
      />
    </>
  );
}
