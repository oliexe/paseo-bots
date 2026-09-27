import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { EMPTY_LIBRARY } from "../../../shared/bot";
import { setBotUses, updateSkill, upsertSkills } from "../../../shared/library";
import { proposalAcceptRpc, proposalDismissRpc, proposalGetRpc } from "../../../shared/rpc";
import { scanSkillText, skillBody } from "../../../shared/skills";
import { skillQueryKey } from "../../library/SkillPage";
import { errorText } from "../../native";
import { Alert } from "../../panel/controls";
import { ui } from "../../typography";
import { useBotSettings } from "../../useBotSettings";
import { PlanCard } from "./PlanCard";
import { CardButton } from "./ui";

type Colors = PluginTheme["colors"];

export const proposalQueryKey = (id: string) => ["paseo-bots", "proposal", id];

/**
 * A skill a bot proposed with propose_skill (usually after /learn), laid out
 * like Paseo's plan card. Saving adds it to Skills & Tools, marked reviewed,
 * and turns it on for the bot that proposed it.
 */
export function SkillProposalCard({ colors, compact, proposalId }: { colors: Colors; compact: boolean; proposalId: string }) {
  const get = useRpc(proposalGetRpc);
  const accept = useRpc(proposalAcceptRpc);
  const dismiss = useRpc(proposalDismissRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { settings, commit } = useBotSettings();
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const query = useQuery({ queryKey: proposalQueryKey(proposalId), queryFn: () => get({ id: proposalId }) });
  const proposal = query.data?.proposal;

  if (query.isPending) return null;
  if (!proposal) {
    return <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{query.isError ? `Couldn't load the proposed skill: ${errorText(query.error)}` : "This proposed skill is no longer available."}</Text>;
  }

  const { name, description, text } = proposal.data;
  const values = settings.status === "ready" ? settings.values : null;
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  const exists = !!values?.library?.skills.some((skill) => skill.id === name);
  const warnings = scanSkillText(text);

  const save = async () => {
    setBusy("save");
    try {
      const { proposal: saved, skill } = await accept({ id: proposal.id });
      await commit((current) => ({
        ...current,
        library: updateSkill(upsertSkills(current.library ?? EMPTY_LIBRARY, [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }]), skill.id, { enabled: true }),
        bots: current.bots.map((entry) => (entry.id === saved.botId ? setBotUses(entry, "skill", skill.id, true) : entry)),
      }));
      queryClient.setQueryData(proposalQueryKey(proposal.id), { proposal: saved });
      void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    } catch (error) {
      toast.error(`Couldn't save the skill: ${errorText(error)}`);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };

  const drop = async () => {
    setBusy("dismiss");
    try {
      queryClient.setQueryData(proposalQueryKey(proposal.id), await dismiss({ id: proposal.id }));
    } catch (error) {
      toast.error(`Couldn't dismiss it: ${errorText(error)}`);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };

  const title = proposal.status === "accepted" ? `Saved skill: ${name}` : proposal.status === "dismissed" ? `Dismissed skill: ${name}` : `${exists ? "Updated" : "New"} skill: ${name}`;
  const footer =
    proposal.status === "pending" ? (
      <>
        {warnings.length ? <Alert colors={colors} variant="warning" title="Check these first" description={warnings} /> : null}
        <Text style={{ fontSize: ui(14), marginVertical: 4, color: colors.foregroundMuted }}>
          {exists ? `Replace ${name} in Skills & Tools` : "Save it to Skills & Tools"}
          {bot ? ` and turn it on for ${bot.name}?` : "?"}
        </Text>
        <View style={compact ? { gap: 8 } : { gap: 8, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <CardButton colors={colors} label="Dismiss" icon="X" busy={!!busy} spinning={busy === "dismiss"} onPress={() => void drop()} />
          <CardButton colors={colors} label={exists ? "Update skill" : "Save skill"} icon="Check" primary busy={!!busy} spinning={busy === "save"} onPress={() => void save()} />
        </View>
      </>
    ) : undefined;

  return (
    <PlanCard
      colors={colors}
      title={title}
      description={description}
      text={skillBody(text)}
      outcome={proposal.status === "accepted" ? "approved" : proposal.status === "dismissed" ? "rejected" : "pending"}
      footer={footer}
    />
  );
}
