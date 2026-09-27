import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { accountLabel, type AppAccount, type AppCard } from "../../shared/apps";
import type { Bot } from "../../shared/bot";
import { appsDisconnectRpc, appsRenameRpc } from "../../shared/rpc";
import { RenameDialog } from "../BotDialogs";
import { confirmDialog, errorText } from "../native";
import { Button } from "../panel/controls";
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
  /** Opens a sign-in for another account of the app, named `alias`. */
  onConnect(alias: string): Promise<void>;
}

/** One connected app: its accounts (named to tell them apart) and which bots may use it. */
export function AppPage({ colors, app, accounts, bots, showTitle, onToggleBot, onDisconnected, onConnect }: AppPageProps) {
  const disconnect = useRpc(appsDisconnectRpc);
  const rename = useRpc(appsRenameRpc);
  const invalidate = useAppsInvalidate();
  const toast = useToast();
  const [naming, setNaming] = useState<AppAccount | "new" | null>(null);

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
      <SettingsSection title="Accounts" info="The sign-ins Composio keeps for this app on this host. Name them to tell them apart; bots pick an account by its name.">
        <SettingsCard>
          {accounts.map((account) => (
            <SettingsRow key={account.id} label={accountLabel(account, app.name)} hint={[account.alias ? account.name : null, STATUS_TEXT[account.status]].filter(Boolean).join(" · ")}>
              <View style={{ flexDirection: "row", gap: 4 }}>
                <Button colors={colors} variant="ghost" size="xs" label="Rename" onPress={() => setNaming(account)} />
                <Button colors={colors} variant="ghost" size="xs" label="Disconnect" onPress={() => void remove(account)} />
              </View>
            </SettingsRow>
          ))}
          <SettingsAction label="Add another account" hint="Sign in with a second account, like a work and a personal one" actionLabel="Connect" onPress={() => setNaming("new")} />
        </SettingsCard>
      </SettingsSection>
      <BotsCard colors={colors} bots={bots} noun="app" uses={(bot) => bot.apps.includes(app.slug)} onToggle={onToggleBot} />
      {naming ? (
        <RenameDialog
          colors={colors}
          title={naming === "new" ? `Add another ${app.name} account` : "Name this account"}
          initialValue={naming === "new" ? "" : (naming.alias ?? "")}
          placeholder="work"
          submitLabel={naming === "new" ? "Continue" : "Save"}
          onClose={() => setNaming(null)}
          onSubmit={async (alias) => {
            if (naming === "new") await onConnect(alias);
            else {
              await rename({ accountId: naming.id, alias });
              await invalidate();
            }
            setNaming(null);
          }}
        />
      ) : null}
    </>
  );
}
