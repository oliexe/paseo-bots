import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { accountLabel, withAppRule, type AppAccount } from "../../shared/apps";
import type { AppRule } from "../../shared/bot";
import { useBotHost } from "../data";
import { connectedApps, useAppsAccounts, useAppsCatalog, useAppsStatus } from "../library/apps";
import { AppLogo } from "../library/parts";
import { openLibrary } from "../navigation";
import { AppAccessSheet } from "./AppAccessSheet";
import type { PanelProps } from "./BotPanel";
import { CardNote, PressableRow, RowText, SectionLink, Switch } from "./controls";

const STATUS_HINT = { connected: null, pending: "Waiting for sign-in", failed: "Sign-in failed. Connect it again in Skills & Tools." } as const;

/** A bot's limits on an app in a few words: "Read-only · work". */
function ruleHint(rule: AppRule | undefined, accounts: readonly AppAccount[], appName: string): string | null {
  if (!rule) return null;
  const account = accounts.find((entry) => entry.id === rule.account);
  const tools = rule.tools === "read" ? "Read-only" : Array.isArray(rule.tools) ? `${rule.tools.length} ${rule.tools.length === 1 ? "tool" : "tools"}` : null;
  return [tools, account ? accountLabel(account, appName) : null].filter(Boolean).join(" · ") || null;
}

/**
 * The apps connected on this host, with a switch each for this bot, like the
 * skill and MCP server pickers. Apps are connected in Skills & Tools; a row
 * opens the bot's limits on the app.
 */
export function AppsPicker({ colors, bot, localHost, onPatch }: Pick<PanelProps, "colors" | "bot" | "localHost" | "onPatch">) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useAppsStatus();
  const configured = status.data?.configured ?? false;
  const accounts = useAppsAccounts(configured);
  const catalog = useAppsCatalog(configured);
  const apps = connectedApps(accounts.data?.accounts ?? [], catalog.data?.apps ?? []);
  const [editing, setEditing] = useState<string | null>(null);
  const editingApp = apps.find((app) => app.slug === editing);
  const appAccounts = (slug: string) => (accounts.data?.accounts ?? []).filter((account) => account.slug === slug && account.status === "connected");
  const toggle = (slug: string, on: boolean) => onPatch({ apps: on ? [...new Set([...bot.apps, slug])] : bot.apps.filter((entry) => entry !== slug) });

  return (
    <SettingsSection
      title="Connected apps"
      info="Apps signed in through Composio on this host. Switched-on apps are reachable through the bot's composio MCP server. Open one to limit its tools or keep the bot to one account."
      trailing={<SectionLink colors={colors} icon="ArrowUpRight" label="Skills & Tools" onPress={() => openLibrary({ kind: "apps" })} />}
    >
      <SettingsCard>
        {!host.isLocal ? <CardNote colors={colors} text="Only bots on this host can use connected apps" /> : null}
        {host.isLocal && status.data && !configured ? <CardNote colors={colors} text="Not set up yet" /> : null}
        {host.isLocal && configured && accounts.isLoading ? <CardNote colors={colors} loading text="Loading..." /> : null}
        {host.isLocal && configured && !accounts.isLoading && apps.length === 0 ? <CardNote colors={colors} text="No apps connected yet" /> : null}
        {host.isLocal && configured
          ? apps.map((app) => (
              <PressableRow key={app.slug} colors={colors} accessibilityLabel={`${app.name} tools and account`} onPress={() => setEditing(app.slug)}>
                {({ hovered }) => (
                  <>
                    <AppLogo colors={colors} app={app} />
                    <RowText colors={colors} label={app.name} hint={STATUS_HINT[app.status] ?? ruleHint(bot.appRules[app.slug], appAccounts(app.slug), app.name)} />
                    <Switch colors={colors} label={`Use ${app.name}`} value={bot.apps.includes(app.slug)} onValueChange={(on) => toggle(app.slug, on)} />
                    <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
                  </>
                )}
              </PressableRow>
            ))
          : null}
      </SettingsCard>
      {editingApp ? (
        <AppAccessSheet
          colors={colors}
          app={editingApp}
          accounts={appAccounts(editingApp.slug)}
          rule={bot.appRules[editingApp.slug]}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            onPatch({ appRules: withAppRule(bot.appRules, editingApp.slug, rule) });
            setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
