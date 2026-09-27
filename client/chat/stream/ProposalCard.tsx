import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { EMPTY_LIBRARY, newRoutineId, type Bot } from "../../../shared/bot";
import { setBotUses, updateSkill, upsertSkills } from "../../../shared/library";
import type { Proposal } from "../../../shared/proposals";
import { describeSchedule, upcomingRuns } from "../../../shared/routines";
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

const OUTCOME = { pending: "pending", accepted: "approved", dismissed: "rejected" } as const;

/**
 * Something a bot proposed with propose_skill (usually after /learn) or
 * propose_routine, laid out like Paseo's plan card with the actions under it.
 * Skills are saved to Skills & Tools as reviewed and turned on for the bot;
 * routines are added to the bot and report back to this chat.
 */
export function ProposalCard({ colors, compact, proposalId }: { colors: Colors; compact: boolean; proposalId: string }) {
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
    return <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{query.isError ? `Couldn't load the proposal: ${errorText(query.error)}` : "This proposal is no longer available."}</Text>;
  }

  const values = settings.status === "ready" ? settings.values : null;
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  const view = proposal.kind === "skill" ? skillView(proposal, bot, !!values?.library?.skills.some((skill) => skill.id === proposal.data.name)) : routineView(proposal, bot);

  const save = async () => {
    setBusy("save");
    try {
      const { proposal: saved, skill } = await accept({ id: proposal.id });
      await commit((current) => {
        if (proposal.kind === "routine") {
          const routine = { id: newRoutineId(), ...proposal.data, enabled: true, createdAt: new Date().toISOString() };
          return { ...current, bots: current.bots.map((entry) => (entry.id === saved.botId ? { ...entry, routines: [...entry.routines, routine] } : entry)) };
        }
        if (!skill) return current;
        return {
          ...current,
          library: updateSkill(upsertSkills(current.library ?? EMPTY_LIBRARY, [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }]), skill.id, { enabled: true }),
          bots: current.bots.map((entry) => (entry.id === saved.botId ? setBotUses(entry, "skill", skill.id, true) : entry)),
        };
      });
      queryClient.setQueryData(proposalQueryKey(proposal.id), { proposal: saved });
      if (skill) void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    } catch (error) {
      toast.error(`Couldn't save it: ${errorText(error)}`);
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

  const footer =
    proposal.status === "pending" ? (
      <>
        {view.warnings.length ? <Alert colors={colors} variant="warning" title="Check these first" description={view.warnings} /> : null}
        {view.notes.map((note) => (
          <Text key={note} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
            {note}
          </Text>
        ))}
        <View style={compact ? { gap: 8, marginTop: 4 } : { gap: 8, marginTop: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <CardButton colors={colors} label="Dismiss" icon="X" busy={!!busy} spinning={busy === "dismiss"} onPress={() => void drop()} />
          <CardButton colors={colors} label={view.action} icon="Check" primary busy={!!busy} spinning={busy === "save"} onPress={() => void save()} />
        </View>
      </>
    ) : undefined;

  return <PlanCard colors={colors} title={view.titles[proposal.status]} description={view.description} text={view.text} outcome={OUTCOME[proposal.status]} footer={footer} />;
}

interface ProposalView {
  titles: Record<Proposal["status"], string>;
  description: string;
  text: string;
  warnings: string[];
  /** Lines above the buttons while it's pending. */
  notes: string[];
  action: string;
}

function skillView(proposal: Extract<Proposal, { kind: "skill" }>, bot: Bot | undefined, exists: boolean): ProposalView {
  const { name, description, text } = proposal.data;
  return {
    titles: { pending: `${exists ? "Updated" : "New"} skill: ${name}`, accepted: `Saved skill: ${name}`, dismissed: `Dismissed skill: ${name}` },
    description,
    text: skillBody(text),
    warnings: scanSkillText(text),
    notes: [`${exists ? `Replace ${name} in Skills & Tools` : "Save it to Skills & Tools"}${bot ? ` and turn it on for ${bot.name}?` : "?"}`],
    action: exists ? "Update skill" : "Save skill",
  };
}

function routineView(proposal: Extract<Proposal, { kind: "routine" }>, bot: Bot | undefined): ProposalView {
  const { name, prompt, schedule } = proposal.data;
  const now = new Date();
  const next = upcomingRuns(schedule, now, now, 3);
  const timing =
    schedule.kind === "webhook"
      ? "It runs when its webhook is called. Copy the URL from the routine's settings."
      : next.length
        ? `Next ${next.length === 1 ? "run" : `${next.length} runs`}: ${next.map((at) => at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ")}`
        : "It has no upcoming runs.";
  return {
    titles: { pending: `New routine: ${name}`, accepted: `Scheduled routine: ${name}`, dismissed: `Dismissed routine: ${name}` },
    description: describeSchedule(schedule),
    text: prompt,
    warnings: [],
    notes: [timing, `Each run starts a new chat${bot ? ` with ${bot.name}` : ""} and posts its result here.`],
    action: "Create routine",
  };
}
