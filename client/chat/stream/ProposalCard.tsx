import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Bot } from "../../../shared/bot";
import { changeWarnings, describeChange } from "../../../shared/changes";
import type { Proposal, ProposalDecision } from "../../../shared/proposals";
import { describeSchedule, upcomingRuns } from "../../../shared/routines";
import { proposalAcceptRpc, proposalDismissRpc, proposalGetRpc, proposalPrepareRpc } from "../../../shared/rpc";
import { scanSkillText, skillBody } from "../../../shared/skills";
import { skillQueryKey } from "../../library/SkillPage";
import { errorText } from "../../native";
import { Alert } from "../../panel/controls";
import { ui } from "../../typography";
import { useBotSettings } from "../../useBotSettings";
import { decideProposal } from "../proposal-decision";
import { PlanCard } from "./PlanCard";
import { CardButton } from "./ui";

type Colors = PluginTheme["colors"];

const proposalQueryKey = (id: string) => ["paseo-bots", "proposal", id];

const OUTCOME = { pending: "pending", accepted: "approved", dismissed: "rejected" } as const;

/**
 * Something a bot proposed with propose_skill (usually after /learn),
 * propose_routine or propose_changes, laid out like Paseo's plan card with the
 * actions under it. Skills are saved to Skills & Tools as reviewed and turned on
 * for the bot; routines are added to the bot and report back to this chat;
 * setup changes are applied together.
 */
export function ProposalCard({ colors, compact, proposalId }: { colors: Colors; compact: boolean; proposalId: string }) {
  const get = useRpc(proposalGetRpc);
  const accept = useRpc(proposalAcceptRpc);
  const prepare = useRpc(proposalPrepareRpc);
  const dismiss = useRpc(proposalDismissRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { settings, latest, commit } = useBotSettings();
  const decisionLock = useRef(false);
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const query = useQuery({
    queryKey: proposalQueryKey(proposalId),
    queryFn: () => get({ id: proposalId }),
    refetchInterval: ({ state }) => {
      const current = state.data?.proposal;
      if (current?.notification?.status === "waiting" || current?.notification?.status === "pending") return 3000;
      return current?.status === "pending" && settings.status === "ready" && settings.values.proposalDecisions?.some((entry) => entry.id === proposalId) ? 3000 : false;
    },
  });
  const proposal = query.data?.proposal;

  if (query.isPending) return null;
  if (!proposal) {
    return <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{query.isError ? `Couldn't load the proposal: ${errorText(query.error)}` : "This proposal is no longer available."}</Text>;
  }

  const values = settings.status === "ready" ? settings.values : null;
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  const view =
    proposal.kind === "skill"
      ? skillView(proposal, bot, !!values?.library?.skills.some((skill) => skill.id === proposal.data.name))
      : proposal.kind === "routine"
        ? routineView(proposal, bot)
        : changesView(proposal);

  const decide = async (status: ProposalDecision) => {
    if (decisionLock.current) return;
    decisionLock.current = true;
    setBusy(status === "accepted" ? "save" : "dismiss");
    try {
      const saved = await decideProposal(proposal, status, {
        values: () => latest.current.status === "ready" ? latest.current.values : null,
        prepare,
        commit,
        complete: async (id, decision) => (await (decision === "accepted" ? accept({ id }) : dismiss({ id }))).proposal,
      });
      if (!saved) return;
      queryClient.setQueryData(proposalQueryKey(proposal.id), { proposal: saved });
      if (saved.kind === "skill" && saved.status === "accepted") void queryClient.invalidateQueries({ queryKey: skillQueryKey(saved.data.name) });
    } catch (error) {
      toast.error(`Couldn't finish the proposal: ${errorText(error)}`);
      void query.refetch();
    } finally {
      decisionLock.current = false;
      setBusy(null);
    }
  };
  const receipt = values?.proposalDecisions?.find((entry) => entry.id === proposal.id);

  const footer =
    proposal.status === "pending" ? (
      <>
        {!receipt && view.warnings.length ? <Alert colors={colors} variant="warning" title="Check these first" description={view.warnings} /> : null}
        {(receipt ? ["Your decision is saved. Finish it to update this card and notify the proposing chat."] : view.notes).map((note) => (
          <Text key={note} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
            {note}
          </Text>
        ))}
        <View style={compact ? { gap: 8, marginTop: 4 } : { gap: 8, marginTop: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          {receipt ? <CardButton colors={colors} label={receipt.status === "accepted" ? "Finish saving" : "Finish dismissal"} icon="RefreshCw" primary busy={!!busy || !values} spinning={!!busy} onPress={() => void decide(receipt.status)} /> : <>
            <CardButton colors={colors} label="Dismiss" icon="X" busy={!!busy || !values} spinning={busy === "dismiss"} onPress={() => void decide("dismissed")} />
            <CardButton colors={colors} label={view.action} icon="Check" primary busy={!!busy || !values} spinning={busy === "save"} onPress={() => void decide("accepted")} />
          </>}
        </View>
      </>
    ) : proposal.notification && proposal.notification.status !== "sent" ? <>
      {proposal.notification.status === "waiting" ? <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>Decision saved. The chat will be notified when the bot finishes its current turn and any permission request is resolved.</Text> : <Alert colors={colors} variant="warning" title="Decision saved" description={proposal.notification.error ?? "The proposing chat has not been notified yet."} />}
      {proposal.notification.status !== "unavailable" ? <CardButton colors={colors} label="Retry notification" icon="RefreshCw" busy={!!busy} spinning={!!busy} onPress={() => void decide(proposal.status === "accepted" ? "accepted" : "dismissed")} /> : null}
    </> : undefined;

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

function changesView(proposal: Extract<Proposal, { kind: "changes" }>): ProposalView {
  const { summary, changes } = proposal.data;
  const count = changes.length === 1 ? "the change" : `all ${changes.length} changes`;
  return {
    titles: { pending: "Setup changes", accepted: "Applied setup changes", dismissed: "Dismissed setup changes" },
    description: summary,
    text: changes.map((change) => `- ${describeChange(change)}`).join("\n"),
    warnings: changeWarnings(changes),
    notes: [`Apply ${count}? A bot's earlier settings stay under History in its settings.`],
    action: "Apply changes",
  };
}
