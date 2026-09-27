import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useBotHost } from "../data";
import { connectedApps, useAppsAccounts, useAppsCatalog, useAppsStatus } from "../library/apps";
import { AppLogo } from "../library/parts";
import { openLibrary } from "../navigation";
import type { PanelProps } from "./BotPanel";
import { CardNote, PressableRow, RowText, SectionLink, Switch } from "./controls";

const STATUS_HINT = { connected: null, pending: "Waiting for sign-in", failed: "Sign-in failed. Connect it again in Skills & Tools." } as const;

/**
 * The apps connected on this host, with a switch each for this bot, like the
 * skill and MCP server pickers. Apps are connected in Skills & Tools; a row
 * opens its page there.
 */
export function AppsPicker({ colors, bot, localHost, onPatch }: Pick<PanelProps, "colors" | "bot" | "localHost" | "onPatch">) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useAppsStatus();
  const configured = status.data?.configured ?? false;
  const accounts = useAppsAccounts(configured);
  const catalog = useAppsCatalog(configured);
  const apps = connectedApps(accounts.data?.accounts ?? [], catalog.data?.apps ?? []);
  const toggle = (slug: string, on: boolean) => onPatch({ apps: on ? [...new Set([...bot.apps, slug])] : bot.apps.filter((entry) => entry !== slug) });

  return (
    <SettingsSection
      title="Connected apps"
      info="Apps signed in through Composio on this host. Switched-on apps are reachable through the bot's composio MCP server."
      trailing={<SectionLink colors={colors} icon="ArrowUpRight" label="Skills & Tools" onPress={() => openLibrary({ kind: "apps" })} />}
    >
      <SettingsCard>
        {!host.isLocal ? <CardNote colors={colors} text="Only bots on this host can use connected apps" /> : null}
        {host.isLocal && status.data && !configured ? <CardNote colors={colors} text="Not set up yet" /> : null}
        {host.isLocal && configured && accounts.isLoading ? <CardNote colors={colors} loading text="Loading..." /> : null}
        {host.isLocal && configured && !accounts.isLoading && apps.length === 0 ? <CardNote colors={colors} text="No apps connected yet" /> : null}
        {host.isLocal && configured
          ? apps.map((app) => (
              <PressableRow key={app.slug} colors={colors} accessibilityLabel={`Open ${app.name} in Skills & Tools`} onPress={() => openLibrary({ kind: "app", id: app.slug })}>
                {({ hovered }) => (
                  <>
                    <AppLogo colors={colors} app={app} />
                    <RowText colors={colors} label={app.name} hint={STATUS_HINT[app.status]} />
                    <Switch colors={colors} label={`Use ${app.name}`} value={bot.apps.includes(app.slug)} onValueChange={(on) => toggle(app.slug, on)} />
                    <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
                  </>
                )}
              </PressableRow>
            ))
          : null}
      </SettingsCard>
    </SettingsSection>
  );
}
