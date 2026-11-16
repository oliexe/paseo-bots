import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { botSettings } from "../../../shared/bot";
import { handoffStatusRpc, type HandoffCard as Card, type HandoffStatus } from "../../../shared/handoff";
import { errorText } from "../../native";

const STATUS: Record<HandoffStatus["state"], string> = { running: "Working", permission: "Needs approval", error: "Failed", finished: "Answered", archived: "Archived" };

export function HandoffCard({ card, onOpenChat }: { colors: PluginTheme["colors"]; compact: boolean; card: Card; onOpenChat?(botId: string, chatId: string): void }) {
  const get = useRpc(handoffStatusRpc);
  const settings = useSettings(botSettings);
  const bot = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === card.targetBotId) : null;
  const query = useQuery({
    queryKey: ["paseo-bots", "handoff", card.requesterAgentId, card.targetAgentId],
    queryFn: () => get({ requesterAgentId: card.requesterAgentId, targetAgentId: card.targetAgentId }),
    refetchInterval: (state) => {
      if (state.state.data?.status === null) return false;
      const current = state.state.data?.status?.state ?? card.status.state;
      return current === "running" || current === "permission" ? 3000 : false;
    },
  });
  const missing = query.isSuccess && query.data.status === null;
  const state = query.data?.status ?? card.status;
  const status = STATUS[state.state];
  return (
    <SettingsSection title={`Asked ${bot?.name ?? card.targetName}`} info={card.request}>
      <SettingsCard>
        <SettingsRow label="Status" hint={missing ? "Unavailable" : query.isError ? "Status unavailable" : state.state === "finished" && !state.reply.trim() ? "Finished" : status} />
        {state.reply ? <View style={{ padding: 16 }}><Markdown>{state.reply}</Markdown></View> : !missing && !query.isError ? <SettingsRow label="Latest reply" hint={state.state === "permission" ? "Open the conversation to review the permission request." : state.state === "running" ? "Working in its own conversation with its own tools and settings." : state.state === "finished" ? "The conversation finished without a reply." : state.state === "archived" ? "This conversation was archived." : "The bot stopped before returning an answer."} /> : null}
        {state.error || query.isError ? <SettingsRow label="Conversation error" error={query.isError ? `Couldn't check this conversation: ${errorText(query.error)}` : state.error} /> : null}
        {missing ? <SettingsRow label="Conversation unavailable" hint="The original conversation is no longer available." /> : null}
        {onOpenChat && !missing ? <SettingsAction label={state.state === "permission" ? "Review permission request" : "Bot conversation"} actionLabel={state.state === "permission" ? "Review request" : "Open conversation"} onPress={() => onOpenChat(card.targetBotId, card.targetAgentId)} /> : null}
        {query.isError ? <SettingsAction label="Check conversation status" actionLabel="Check again" onPress={() => void query.refetch()} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
