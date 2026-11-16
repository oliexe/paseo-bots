import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { interactionGetRpc } from "../../../shared/interaction";
import { errorText } from "../../native";

/** A durable tool receipt repairs the native row after the provider rebuilds history. */
export function InteractionRecovery({ id, agentId }: { id: string; agentId: string }) {
  const get = useRpc(interactionGetRpc);
  const query = useQuery({ queryKey: ["paseo-bots", "interaction-recovery", agentId, id], queryFn: () => get({ id, agentId, restore: true }), retry: false });
  if (query.isError) return <SettingsCard><SettingsAction label="Interactive card" error={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  if (query.isSuccess && !query.data.interaction) return <SettingsCard><SettingsRow label="Interactive card" hint="This saved card is no longer available." /></SettingsCard>;
  // The authoritative appended row renders the actual card, once only.
  return null;
}
