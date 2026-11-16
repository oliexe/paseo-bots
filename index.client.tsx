import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { z } from "zod";
import { BotsSurface } from "./client/BotsSurface";
import { BOT_SCREENS, resolveBotScreen } from "./client/screen-navigation";
import { NativeConnectCard } from "./client/chat/stream/ConnectCard";
import { ProposalCard } from "./client/chat/stream/ProposalCard";
import { RoutineRunCard } from "./client/chat/stream/RoutineRunCard";
import { InteractionCard } from "./client/chat/stream/InteractionCard";
import { InteractionRecovery } from "./client/chat/stream/InteractionRecovery";
import { INTERACTION_CARD, InteractionIdSchema, InteractionSchema, interactionIdOf } from "./shared/interaction";
import { HandoffCard } from "./client/chat/stream/HandoffCard";
import { HANDOFF_CARD, HandoffCardSchema } from "./shared/handoff";
import { requestIntent } from "./client/intent";
import { RoutinesScreen } from "./client/RoutinesScreen";
import { PaseoBotsSidebar } from "./client/PaseoSidebar";
import { BackBar } from "./client/library/parts";
import { useTypeScale } from "./client/typography";
import { installTooltips } from "./client/ui/Tooltip";
import { appSignIns } from "./shared/apps";
import { BOT_LABEL } from "./shared/bot";
import { proposalIdOf } from "./shared/proposals";
import { APP_SIGN_IN_CARD, AppSignInSchema, helloRpc, ROUTINE_RUN_CARD, RoutineRunCardSchema } from "./shared/rpc";
import { LEARN_COMMAND, learnPrompt } from "./shared/skills";

/** The plugin's screen, under the id of the sidebar item it replaced so saved links still open it. */
const BOTS_SCREEN = "bots";

function BotsPage({ props, title, onBack, children }: { props: PluginScreenProps; title: string; onBack(): void; children: ReactNode }) {
  useTypeScale();
  return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}><BackBar colors={props.theme.colors} title={title} backLabel="Back to Bots" onBack={onBack} />{children}</View>;
}

function registerBotScreen(client: PluginClientContext, definition: typeof BOT_SCREENS[number]) {
  const { id, title } = definition;
  function BotScreenPage(props: PluginScreenProps) {
    const screen = resolveBotScreen(id, props.params);
    return <BotsSurface key={`${props.host.id}:${screen}`} {...props} screen={screen} openScreen={(input) => client.openScreen(input)} />;
  }
  client.addScreen({
    id,
    title: (params) => resolveBotScreen(id, params) === "bots" ? "Bots" : params.title || title,
    Component: BotScreenPage,
  });
}

export default function contribute(client: PluginClientContext) {
  // Hands the daemon side its Paseo API so bot routines can run.
  void client.rpc(helloRpc, {}).catch(() => {});
  const removeTooltips = installTooltips();
  for (const screen of BOT_SCREENS) {
    registerBotScreen(client, screen);
  }
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: PaseoBotsSidebar });
  const backToBots = () => client.openScreen({ screenId: BOTS_SCREEN });
  // Existing open tabs/bookmarks from the removed settings page return to Bots.
  function PreviousSettingsRoute() {
    useEffect(() => { void backToBots(); }, []);
    return null;
  }
  client.addScreen({ id: "bot-preferences", title: "Bots", Component: PreviousSettingsRoute });
  client.addScreen({ id: "bot-routines", title: "Bots", Component: (props) => <BotsPage props={props} title="Routines" onBack={backToBots}><RoutinesScreen {...props} openScreen={(input) => client.openScreen(input)} /></BotsPage> });
  client.addCommandCenterItem({
    id: "open-bots",
    title: "Open Bots",
    icon: "Bot",
    keywords: ["bot", "assistant", "persona"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: BOTS_SCREEN });
    },
  });
  client.addCommandCenterItem({
    id: "new-bot",
    title: "New bot",
    icon: "Plus",
    keywords: ["bot", "create", "assistant"],
    context: "global",
    onSelect({ openScreen }) {
      requestIntent({ kind: "new-bot" });
      openScreen({ screenId: BOTS_SCREEN });
    },
  });
  // Bot chats opened in Paseo's own agent view get the same /learn and skill cards.
  client.addSlashCommand({
    ...LEARN_COMMAND,
    context: "agent",
    async onSubmit({ agent, args, paseo }) {
      if (!agent.labels[BOT_LABEL]) throw new Error("/learn works in bot chats.");
      await paseo.agents.ref(agent.id).send(learnPrompt(args));
    },
  });
  client.addTimelineTransformer({
    id: "proposals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const proposalId = proposalIdOf(item);
      return proposalId ? { items: [{ type: "plugin", kind: "proposal", version: 1, data: { proposalId } }] } : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: "proposal",
    version: 1,
    schema: z.object({ proposalId: z.string() }),
    Component: ({ item, theme, layout }) => <ProposalCard colors={theme.colors} compact={layout.compact} proposalId={item.data.proposalId} />,
  });
  // A bot's request to connect an app, in Paseo's view too.
  client.addTimelineTransformer({
    id: "app-sign-ins",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const signIns = appSignIns(item);
      return signIns.length ? { items: signIns.map((data) => ({ type: "plugin", ...APP_SIGN_IN_CARD, data })) } : undefined;
    },
  });
  client.addTimelineRenderer({
    ...APP_SIGN_IN_CARD,
    schema: AppSignInSchema,
    Component: ({ item, agentId, timestamp, theme }) => <NativeConnectCard colors={theme.colors} signIn={item.data} since={timestamp.getTime()} agentId={agentId} />,
  });
  // A routine's results chat opened in Paseo's view shows its run cards too (no navigation there).
  client.addTimelineRenderer({
    ...ROUTINE_RUN_CARD,
    schema: RoutineRunCardSchema,
    Component: ({ item, theme }) => <RoutineRunCard colors={theme.colors} card={item.data} />,
  });
  client.addTimelineRenderer({
    ...INTERACTION_CARD,
    schema: InteractionSchema,
    Component: ({ item, theme, layout }) => <InteractionCard colors={theme.colors} compact={layout.compact} initial={item.data} />,
  });
  client.addTimelineTransformer({ id: "interactive-card-recovery", query: { itemType: "tool_call" }, transform({ item }) {
    const id = interactionIdOf(item);
    return id ? { items: [{ type: "plugin", kind: "interaction-reference", version: 1, data: { id } }] } : undefined;
  } });
  client.addTimelineRenderer({ kind: "interaction-reference", version: 1, schema: z.object({ id: InteractionIdSchema }), Component: ({ item, agentId }) => <InteractionRecovery id={item.data.id} agentId={agentId} /> });
  client.addTimelineRenderer({
    ...HANDOFF_CARD,
    schema: HandoffCardSchema,
    Component: ({ item, theme, layout }) => <HandoffCard colors={theme.colors} compact={layout.compact} card={item.data} onOpenChat={(botId, chatId) => client.openScreen({ screenId: "bot-chat", params: { botId, chatId } })} />,
  });
  return removeTooltips;
}
