import { useRpc } from "@getpaseo/plugin/client";
import { Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { newRoutineId, type Bot, type Routine, type RoutineSchedule } from "../../shared/bot";
import { displayTitle, ROUTINE_LABEL } from "../../shared/chat";
import { CRON_PRESETS, describeCron, describeSchedule, formatLocalDateTime, nextRun, parseLocalDateTime, scheduleToCron, upcomingRuns, validateCron } from "../../shared/routines";
import { routineRunNowRpc, routineStatusRpc, routineWebhookRpc, type RoutineRun } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { useBotChats, useBotHost, type BotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import { useMenu } from "../ui/Menu";
import { Alert, type BadgeVariant, Button, CardNote, DrillRow, InputField, KebabButton, PressableRow, RowText, SectionLink, SheetFooter, StatusBadge, TextAreaField } from "./controls";
import type { PanelProps } from "./BotPanel";

type Colors = PanelProps["colors"];

// Routines follow Paseo's Schedules (components/schedules/*): a card of rows with a status
// badge and a kebab (Edit, Pause/Resume, Run now, Delete), and a sheet form with a cadence
// preset + cron field. Runs happen on the host that stores the bot (server/scheduler.ts).

/** Paseo's formatNextRun (utils/schedule-format.ts): "soon", "in 12m", "in 3h", "in 2d". */
function formatNextRun(next: Date, now: number = Date.now()): string {
  const diff = next.getTime() - now;
  if (diff < 60_000) return "soon";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

function routineState(routine: Routine, next: Date | null): { label: string; variant: BadgeVariant } {
  if (!routine.enabled) return { label: "Paused", variant: "muted" };
  // A webhook routine has no next time but stays ready to run.
  if (!next && routine.schedule.kind !== "webhook") return { label: "Finished", variant: "muted" };
  return { label: "Active", variant: "success" };
}

/** Cadence → history → future, like Paseo's schedule rows; status stays on the badge. */
function routineMeta(routine: Routine, run: RoutineRun | undefined, next: Date | null): string {
  const parts = [describeSchedule(routine.schedule)];
  const when = relativeTime(run?.startedAt);
  if (!run) parts.push("Never run");
  else if (run.status === "failed") parts.push(`Failed ${when}: ${run.error ?? "unknown error"}`);
  else if (run.status === "skipped-busy") parts.push(`Skipped ${when}, still working`);
  else if (run.status === "skipped-missed") parts.push(`Missed ${when}`);
  else parts.push(`Last run ${when}`);
  if (routine.enabled && next) parts.push(`Next run ${formatNextRun(next)}`);
  return parts.join(" · ");
}

const ROUTINES_KEY = ["paseo-bots", "routines"];
const UPCOMING = 6;
const UPCOMING_DAYS = 7;
const RECENT = 10;
const RUN_LABELS: Record<RoutineRun["status"], string> = { running: "Running", succeeded: "Done", failed: "Failed", "skipped-busy": "Skipped, still working", "skipped-missed": "Missed" };
const TRIGGER_LABELS: Record<RoutineRun["trigger"], string> = { schedule: "on schedule", manual: "run by you", webhook: "from its webhook" };

/** "Today 09:00", "Tomorrow 09:00" or "Mon, Sep 28 09:00". */
function runTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const offset = Math.round((day - today) / 86_400_000);
  if (offset === 0) return `Today ${time}`;
  if (offset === 1) return `Tomorrow ${time}`;
  if (offset === -1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export function RoutinesSection({ colors, bot, localHost, onPatch, flush, onOpenChat }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useRpc(routineStatusRpc);
  const runNow = useRpc(routineRunNowRpc);
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const records = useQuery({ queryKey: ROUTINES_KEY, queryFn: () => status({}), refetchInterval: 15_000, enabled: host.isLocal });
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [runs, setRuns] = useState(false);

  const setRoutines = (routines: Routine[]) => onPatch({ routines });
  const update = (id: string, patch: Partial<Routine>) => setRoutines(bot.routines.map((routine) => (routine.id === id ? { ...routine, ...patch } : routine)));
  const recordOf = (routine: Routine) => records.data?.routines[routine.id];

  const run = async (routine: Routine) => {
    try {
      await flush();
      const { run: started } = await runNow({ botId: bot.id, routineId: routine.id });
      if (started.status === "running") toast.show(`Started "${routine.name}". It appears as a chat under ${bot.name}.`, { variant: "success" });
      else if (started.status === "skipped-busy") toast.show(`"${routine.name}" is still working on its last run.`);
      else toast.error(started.error ?? "Couldn't start the run.");
      void queryClient.invalidateQueries({ queryKey: ["paseo-bots"] });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const copyWebhook = async (routine: Routine) => {
    try {
      await flush();
      await copyText((await webhook({ routineId: routine.id })).url);
      toast.show("Webhook URL copied", { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const remove = async (routine: Routine) => {
    const confirmed = await confirmDialog({
      title: "Delete routine",
      message: `Delete "${routine.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed) setRoutines(bot.routines.filter((entry) => entry.id !== routine.id));
  };

  if (!host.isLocal) {
    return <Alert colors={colors} description="Routines run on the host that stores the bot. Switch the bot to this host to schedule it." />;
  }

  const now = new Date();
  const upcoming = bot.routines
    .filter((routine) => routine.enabled)
    .flatMap((routine) => upcomingRuns(routine.schedule, new Date(recordOf(routine)?.lastRunAt ?? routine.createdAt), now, UPCOMING).map((at) => ({ at, routine })))
    .filter(({ at }) => at.getTime() - now.getTime() <= UPCOMING_DAYS * 86_400_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, UPCOMING);
  const recent = bot.routines
    .flatMap((routine) => (recordOf(routine)?.runs ?? []).map((entry) => ({ run: entry, routine })))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, RECENT);

  return (
    <>
      {records.data?.scheduler === false ? (
        <View style={{ marginBottom: 24 }}>
          <Alert colors={colors} variant="warning" description="The scheduler on this host is starting" />
        </View>
      ) : null}
      <SettingsSection
        title="Routines"
        info="Each run starts a new chat under this bot with the routine's prompt, at the bot's mode. Runs missed by under 12 hours catch up once."
        trailing={<SectionLink colors={colors} label="New routine" onPress={() => setEditing("new")} />}
      >
        <SettingsCard>
          {bot.routines.length === 0 ? <CardNote colors={colors} text="No routines yet" /> : null}
          {bot.routines.map((routine) => {
            const record = recordOf(routine);
            const next = nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now);
            const badge = routineState(routine, next);
            return (
              <PressableRow key={routine.id} colors={colors} accessibilityLabel={`Edit routine ${routine.name}`} onPress={() => setEditing(routine)}>
                {() => (
                  <>
                    <RowText colors={colors} label={routine.name || "Untitled routine"} hint={routineMeta(routine, record?.runs.at(-1), next)} hintLines={2} />
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <StatusBadge colors={colors} label={badge.label} variant={badge.variant} />
                      <KebabButton
                        colors={colors}
                        label="Routine actions"
                        onOpen={(anchor) =>
                          menu.open({
                            anchor,
                            align: "end",
                            width: 220,
                            title: routine.name || "Routine",
                            entries: [
                              { label: "Edit routine", icon: "Pencil", onSelect: () => setEditing(routine) },
                              routine.enabled
                                ? { label: "Pause routine", icon: "Pause", onSelect: () => update(routine.id, { enabled: false }) }
                                : { label: "Resume routine", icon: "Play", onSelect: () => update(routine.id, { enabled: true }) },
                              { label: "Run now", icon: "RotateCw", disabled: !routine.prompt.trim(), pendingLabel: "Starting...", onSelect: () => run(routine) },
                              ...(routine.schedule.kind === "webhook" ? [{ label: "Copy webhook URL", icon: "Webhook", onSelect: () => copyWebhook(routine) }] : []),
                              { kind: "separator" as const },
                              { label: "Delete routine", icon: "Trash2", destructive: true, onSelect: () => void remove(routine) },
                            ],
                          })
                        }
                      />
                    </View>
                  </>
                )}
              </PressableRow>
            );
          })}
        </SettingsCard>
      </SettingsSection>
      {bot.routines.length ? (
        <SettingsSection title="Activity">
          <SettingsCard>
            <DrillRow
              colors={colors}
              label="Runs"
              hint={[upcoming[0] ? `Next ${runTime(upcoming[0].at, now)}` : null, recent[0] ? `last ${runTime(new Date(recent[0].run.startedAt), now)}` : null].filter(Boolean).join(", ") || "None yet"}
              onPress={() => setRuns(true)}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {runs ? (
        <Modal title="Runs" open onOpenChange={(next) => !next && setRuns(false)}>
          <Modal.Content contentContainerStyle={{ gap: 0 }}>
            <SettingsSection title="Upcoming" info={`The next runs over the coming ${UPCOMING_DAYS} days, in this host's local time.`}>
              <SettingsCard>
                {upcoming.length === 0 ? <CardNote colors={colors} text="Nothing scheduled" /> : null}
                {upcoming.map(({ at, routine }) => (
                  <SettingsRow key={`${routine.id}:${at.getTime()}`} label={runTime(at, now)} hint={routine.name} />
                ))}
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Recent runs" info="The latest runs of this bot's routines. Open one to see its chat.">
              <SettingsCard>
                {recent.length === 0 ? <CardNote colors={colors} text="No runs yet" /> : null}
                {recent.map(({ run: entry, routine }) => {
                  const hint = [`${runTime(new Date(entry.startedAt), now)} · ${RUN_LABELS[entry.status]} · ${TRIGGER_LABELS[entry.trigger]}`, entry.error ?? entry.output].filter(Boolean).join("\n");
                  const agentId = entry.agentId;
                  return agentId ? (
                    <DrillRow
                      key={entry.id}
                      colors={colors}
                      label={routine.name}
                      hint={hint}
                      hintLines={2}
                      onPress={() => {
                        setRuns(false);
                        onOpenChat(agentId);
                      }}
                    />
                  ) : (
                    <SettingsRow key={entry.id} label={routine.name} hint={hint} />
                  );
                })}
              </SettingsCard>
            </SettingsSection>
          </Modal.Content>
        </Modal>
      ) : null}
      {editing ? (
        <RoutineForm
          colors={colors}
          bot={bot}
          host={host}
          routine={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSubmit={(routine) => {
            setRoutines(editing === "new" ? [...bot.routines, routine] : bot.routines.map((entry) => (entry.id === routine.id ? routine : entry)));
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- form

const CUSTOM_CRON = "Custom cron";
const ONCE = "once";
const WEBHOOK = "webhook";
const OWN_CHAT = "own";

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

interface RoutineFormProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  routine: Routine | null;
  onCancel(): void;
  onSubmit(routine: Routine): void;
}

function RoutineForm({ colors, bot, host, routine, onCancel, onSubmit }: RoutineFormProps) {
  const original: RoutineSchedule = routine?.schedule ?? { kind: "cron", expression: "0 9 * * 1-5" };
  // A new routine's id is picked now so its webhook URL can be shown before saving.
  const [id] = useState(() => routine?.id ?? newRoutineId());
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [resultsChatId, setResultsChatId] = useState<string | null>(routine?.resultsChatId ?? null);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
  const [onceText, setOnceText] = useState(() => formatLocalDateTime(original.kind === "once" ? new Date(original.at) : inAnHour()));
  // Presets rewrite the cron field; remounting it is how Paseo's CadenceEditor resets it too.
  const [cronKey, setCronKey] = useState(0);
  const chats = useBotChats(host, bot.id);

  const once = schedule.kind === "once";
  const hook = schedule.kind === "webhook";
  const trimmedCron = cronText.trim();
  const presetValue = once ? ONCE : hook ? WEBHOOK : (CRON_PRESETS.find((preset) => preset.expression === trimmedCron)?.id ?? CUSTOM_CRON);
  const cronError = once || hook ? null : validateCron(trimmedCron);
  const onceDate = once ? parseLocalDateTime(onceText) : null;
  const onceChanged = original.kind !== "once" || onceDate?.getTime() !== new Date(original.at).getTime();
  const onceError = !once ? null : !onceDate ? "Use YYYY-MM-DD HH:MM" : onceChanged && onceDate.getTime() <= Date.now() ? "Pick a time in the future" : null;
  const canSubmit = prompt.trim().length > 0 && !cronError && !onceError;

  // Runs' own chats aren't offered as a results chat; a chosen chat that's gone stays listed so it can be changed.
  const resultChats = (chats.data ?? []).filter((chat) => !chat.labels?.[ROUTINE_LABEL]);
  const resultOptions = [
    { label: "Only the run's own chat", value: OWN_CHAT },
    ...resultChats.map((chat) => ({ label: displayTitle(chat.title), value: chat.id })),
    ...(resultsChatId && !resultChats.some((chat) => chat.id === resultsChatId) ? [{ label: "A chat that's no longer here", value: resultsChatId }] : []),
  ];

  const submit = () => {
    const firstLine = prompt.trim().split("\n")[0]!.slice(0, 60);
    const base: Routine = routine ?? { id, name: "", prompt: "", enabled: true, schedule, resultsChatId: null, createdAt: new Date().toISOString() };
    onSubmit({ ...base, name: name.trim().slice(0, 80) || firstLine, prompt, schedule, resultsChatId });
  };

  return (
    <Modal title={routine ? "Edit routine" : "New routine"} open onOpenChange={(open) => !open && onCancel()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" initialValue={name} placeholder="Morning check-in" onChangeText={setName} />
            <TextAreaField colors={colors} label="Prompt" hint="Sent as the first message of each run" defaultValue={prompt} onChangeText={setPrompt} placeholder="What should the bot do each run?" />
          </SettingsCard>
        </View>
        <SettingsSection title="Cadence" info="In this host's local time. A run that's still working when the next is due is skipped.">
          <SettingsCard>
            <SettingsSelect
              label="Repeats"
              value={presetValue}
              options={[...CRON_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })), { label: "Once", value: ONCE }, { label: "When its webhook is called", value: WEBHOOK }]}
              onValueChange={(value) => {
                if (value === ONCE) {
                  setSchedule({ kind: "once", at: (parseLocalDateTime(onceText) ?? inAnHour()).toISOString() });
                  return;
                }
                if (value === WEBHOOK) {
                  setSchedule({ kind: "webhook" });
                  return;
                }
                const preset = CRON_PRESETS.find((entry) => entry.id === value);
                if (!preset) return;
                setCronText(preset.expression);
                setCronKey((key) => key + 1);
                setSchedule({ kind: "cron", expression: preset.expression });
              }}
            />
            {hook ? (
              <WebhookRows colors={colors} routineId={id} />
            ) : once ? (
              <InputField colors={colors}
                key="once"
                label="At"
                hint={onceDate ? onceDate.toLocaleString() : "YYYY-MM-DD HH:MM"}
                error={onceError}
                initialValue={onceText}
                placeholder="2026-09-27 09:00"
                onChangeText={(text) => {
                  setOnceText(text);
                  const at = parseLocalDateTime(text);
                  if (at) setSchedule({ kind: "once", at: at.toISOString() });
                }}
              />
            ) : (
              <InputField colors={colors}
                key={`cron-${cronKey}`}
                label="Cron"
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                hint={trimmedCron ? (describeCron(trimmedCron) ?? trimmedCron) : undefined}
                error={cronError}
                initialValue={cronText}
                placeholder="0 9 * * *"
                onChangeText={(text) => {
                  setCronText(text);
                  setSchedule({ kind: "cron", expression: text.trim() });
                }}
              />
            )}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Results" info="Every run has its own chat. A results chat also gets a card for each run with how it went.">
          <SettingsCard>
            <SettingsSelect label="Post results to" value={resultsChatId ?? OWN_CHAT} options={resultOptions} onValueChange={(value) => setResultsChatId(value === OWN_CHAT ? null : value)} />
          </SettingsCard>
        </SettingsSection>
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" onPress={onCancel} style={{ flex: 1 }} />
          <Button colors={colors} size="md" variant="default" label={routine ? "Save changes" : "Create routine"} disabled={!canSubmit} onPress={submit} style={{ flex: 1 }} />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/** The routine's webhook URL with Copy, and New URL to stop the old one working. */
function WebhookRows({ colors, routineId }: { colors: Colors; routineId: string }) {
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "webhook", routineId];
  const url = useQuery({ queryKey: key, queryFn: () => webhook({ routineId }) });

  const rotate = async () => {
    const confirmed = await confirmDialog({ title: "New webhook URL", message: "The current URL stops working. Anything that calls it needs the new one.", confirmLabel: "Replace", destructive: true });
    if (!confirmed) return;
    try {
      queryClient.setQueryData(key, await webhook({ routineId, rotate: true }));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const value = url.data?.url;
  return (
    <>
      <SettingsAction
        label="Webhook URL"
        hint={value ?? (url.isError ? errorText(url.error) : "Loading...")}
        actionLabel="Copy"
        disabled={!value}
        onPress={() => void copyText(value!).then(() => toast.show("Webhook URL copied", { variant: "success" }))}
      />
      <SettingsAction label="New URL" hint="POST to it from this computer; the body reaches the bot as data, not instructions." actionLabel="Replace" disabled={!value} onPress={() => void rotate()} />
    </>
  );
}
