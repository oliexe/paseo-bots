import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useAgent, usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { AppSignIn } from "../../../shared/apps";
import { BOT_LABEL } from "../../../shared/bot";
import { useAppsAccounts, useAppsCatalog } from "../../library/apps";
import { AppLogo } from "../../library/parts";
import { errorText } from "../../native";
import { StatusBadge } from "../../panel/controls";
import { ui } from "../../typography";
import { useBotSettings } from "../../useBotSettings";
import { CardButton } from "./ui";

type Colors = PluginTheme["colors"];

/** Composio's sign-in links expire ten minutes after the bot asks for them. */
const LINK_TTL_MS = 10 * 60_000;

/**
 * A sign-in a bot started with COMPOSIO_MANAGE_CONNECTIONS, as OpenMausBot's
 * connect card: the user opens Composio's page from here, the card waits for
 * the account to turn active, and Continue tells the bot. Connecting also
 * lets the bot use the app.
 */
export function ConnectCard({ colors, signIn, since, agentId, botId }: { colors: Colors; signIn: AppSignIn; since: number; agentId: string | null; botId: string | null }) {
  const paseo = usePaseo();
  const toast = useToast();
  const { settings, commit } = useBotSettings();
  const [phase, setPhase] = useState<"idle" | "waiting" | "connected" | "continued">("idle");
  const accounts = useAppsAccounts(true, phase === "waiting");
  const catalog = useAppsCatalog(true);
  const app = catalog.data?.apps.find((entry) => entry.slug === signIn.slug) ?? { name: signIn.slug, logo: null, domain: null };
  // Without the account's id or alias there's nothing to wait for, so Continue shows once the page is open.
  const tracked = !!(signIn.wordId || signIn.alias);
  const connected = !!accounts.data?.accounts.some(
    (account) => account.slug === signIn.slug && account.status === "connected" && (signIn.wordId ? account.wordId === signIn.wordId : account.alias === signIn.alias),
  );
  const bot = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  const expired = !connected && phase === "idle" && Date.now() - since > LINK_TTL_MS;

  useEffect(() => {
    if (phase === "waiting" && connected) setPhase("connected");
  }, [phase, connected]);

  const open = async () => {
    try {
      if (bot && !bot.apps.includes(signIn.slug)) {
        await commit((current) => ({ ...current, bots: current.bots.map((entry) => (entry.id === bot.id ? { ...entry, apps: [...entry.apps, signIn.slug] } : entry)) }));
      }
      await openExternalUrl(signIn.url);
      setPhase(tracked ? "waiting" : "connected");
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const carryOn = async () => {
    if (!agentId) return;
    try {
      await paseo.agents.ref(agentId).send(`${app.name} is connected. Please continue.`);
      setPhase("continued");
    } catch (error) {
      toast.error(`Couldn't send it: ${errorText(error)}`);
    }
  };

  const done = connected || phase === "connected" || phase === "continued";
  const badge = done ? { label: "Connected", variant: "success" as const } : phase === "waiting" ? { label: "Waiting", variant: "muted" as const } : expired ? { label: "Expired", variant: "muted" as const } : null;
  const who = bot?.name ?? "The bot";
  const account = signIn.alias ? ` as "${signIn.alias}"` : "";
  const note = done
    ? null
    : expired
      ? `The sign-in link has expired. Ask ${who} for a new one.`
      : phase === "waiting"
        ? "Finish signing in in your browser. This card updates when it's done."
        : `${who} asked to connect ${app.name}${account}. You sign in on Composio's page.${bot && !bot.apps.includes(signIn.slug) ? ` Connecting also lets ${bot.name} use it.` : ""}`;

  return (
    <View style={{ marginVertical: 12, padding: 12, borderRadius: 8, borderWidth: 1, backgroundColor: colors.surface1, borderColor: colors.border, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}>
        <AppLogo colors={colors} app={app} size={16} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: ui(14), lineHeight: 22 }}>
          {done ? `${app.name} connected` : `Connect ${app.name}`}
        </Text>
        {badge ? <StatusBadge colors={colors} label={badge.label} variant={badge.variant} /> : null}
      </View>
      {note ? <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), lineHeight: 20 }}>{note}</Text> : null}
      {!done && !expired ? (
        <View style={{ flexDirection: "row" }}>
          <CardButton colors={colors} label={phase === "waiting" ? "Open the page again" : "Sign in"} icon="ArrowUpRight" primary={phase === "idle"} onPress={() => void open()} />
        </View>
      ) : null}
      {phase === "connected" && agentId ? (
        <View style={{ flexDirection: "row" }}>
          <CardButton colors={colors} label="Continue" icon="Check" primary onPress={() => void carryOn()} />
        </View>
      ) : null}
    </View>
  );
}

/** The card in Paseo's own agent view, which knows the chat but not its bot. */
export function NativeConnectCard(props: { colors: Colors; signIn: AppSignIn; since: number; agentId: string }) {
  const botId = useAgent(props.agentId, (agent) => agent.labels[BOT_LABEL] ?? null);
  return <ConnectCard {...props} botId={botId} />;
}
