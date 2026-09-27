import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { AppAccount, AppCard } from "../../shared/apps";
import type { Bot } from "../../shared/bot";
import { appsDisconnectRpc } from "../../shared/rpc";
import { confirmDialog, errorText } from "../native";
import { useAppsInvalidate } from "./apps";
import { BotsCard, PageTitle } from "./parts";

type Colors = PluginTheme["colors"];

const STATUS_TEXT: Record<AppAccount["status"], string> = {
  connected: "Connected",
  pending: "Waiting for sign-in",
  failed: "Sign-in failed or expired. Connect it again from Connected apps.",
};

interface AppPageProps {
  colors: Colors;
  app: AppCard;
  accounts: AppAccount[];
  bots: Bot[];
  showTitle: boolean;
  onToggleBot(bot: Bot, on: boolean): void;
  onDisconnected(): void;
}

/** One connected app: its account and which bots may use it. */
export function AppPage({ colors, app, accounts, bots, showTitle, onToggleBot, onDisconnected }: AppPageProps) {
  const disconnect = useRpc(appsDisconnectRpc);
  const invalidate = useAppsInvalidate();
  const toast = useToast();

  const remove = async (account: AppAccount) => {
    const confirmed = await confirmDialog({
      title: `Disconnect ${app.name}?`,
      message: "Bots can't use it until it's connected again. Composio revokes the sign-in.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await disconnect({ accountId: account.id });
      await invalidate();
      if (accounts.length === 1) onDisconnected();
    } catch (error) {
      toast.error(`Couldn't disconnect: ${errorText(error)}`);
    }
  };

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={app.name} /> : null}
      <SettingsSection title="Account" info="The sign-in Composio keeps for this app on this host.">
        <SettingsCard>
          {accounts.map((account) => (
            <SettingsAction key={account.id} label={app.name} hint={STATUS_TEXT[account.status]} actionLabel="Disconnect" onPress={() => void remove(account)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <BotsCard colors={colors} bots={bots} noun="app" uses={(bot) => bot.apps.includes(app.slug)} onToggle={onToggleBot} />
    </>
  );
}
