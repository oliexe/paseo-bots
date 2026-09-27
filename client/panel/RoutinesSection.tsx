import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { newRoutineId, type Routine, type RoutineSchedule } from "../../shared/bot";
import { CRON_PRESETS, describeCron, describeSchedule, nextRun, scheduleToCron, validateCron } from "../../shared/routines";
import { routineRunNowRpc, routineStatusRpc, type RoutineRunState } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { useBotHost } from "../data";
import { confirmDialog } from "../native";
import { useMenu } from "../ui/Menu";
import { Alert, type BadgeVariant, Button, CardNote, InputField, KebabButton, PressableRow, RowText, SectionLink, SheetFooter, StatusBadge, TextAreaField } from "./controls";
import type { PanelProps } from "./BotPanel";

type Colors = PanelProps["colors"];

// Routines follow Paseo's Schedules (components/schedules/*): a card of rows with a status
// badge and a kebab (Edit, Pause/Resume, Run now, Delete), and a sheet form with a cadence
// preset + cron field. Runs happen on the host that stores the bot (server/scheduler.ts).

const CUSTOM_CRON = "Custom cron";
const ONCE = "once";

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
  if (!next) return { label: "Finished", variant: "muted" };
  return { label: "Active", variant: "success" };
}

/** Cadence → history → future, like Paseo's schedule rows; status stays on the badge. */
function routineMeta(routine: Routine, run: RoutineRunState | undefined, next: Date | null): string {
  const parts = [describeSchedule(routine.schedule)];
  const when = relativeTime(run?.lastRunAt);
  if (!run?.lastRunAt) parts.push("Never run");
  else if (run.lastStatus === "failed") parts.push(`Failed ${when}: ${run.lastError ?? "unknown error"}`);
  else if (run.lastStatus === "skipped-busy") parts.push(`Skipped ${when}, still working`);
  else if (run.lastStatus === "skipped-missed") parts.push(`Missed ${when}`);
  else parts.push(`Last run ${when}`);
  if (routine.enabled && next) parts.push(`Next run ${formatNextRun(next)}`);
  return parts.join(" · ");
}

export function RoutinesSection({ colors, bot, localHost, onPatch, flush }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useRpc(routineStatusRpc);
  const runNow = useRpc(routineRunNowRpc);
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ["paseo-bot", "routines"], queryFn: () => status({}), refetchInterval: 15_000, enabled: host.isLocal });
  const [editing, setEditing] = useState<Routine | "new" | null>(null);

  const setRoutines = (routines: Routine[]) => onPatch({ routines });
  const update = (id: string, patch: Partial<Routine>) => setRoutines(bot.routines.map((routine) => (routine.id === id ? { ...routine, ...patch } : routine)));

  const run = async (routine: Routine) => {
    try {
      await flush();
      await runNow({ botId: bot.id, routineId: routine.id });
      toast.show(`Started "${routine.name}". It appears as a chat under ${bot.name}.`, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["paseo-bot"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
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
  return (
    <>
      {runs.data?.scheduler === false ? (
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
            const record = runs.data?.runs[routine.id];
            const next = nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now);
            const badge = routineState(routine, next);
            return (
              <PressableRow key={routine.id} colors={colors} accessibilityLabel={`Edit routine ${routine.name}`} onPress={() => setEditing(routine)}>
                {() => (
                  <>
                    <RowText colors={colors} label={routine.name || "Untitled routine"} hint={routineMeta(routine, record, next)} hintLines={2} />
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
                              { kind: "separator" },
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
      {editing ? (
        <RoutineForm
          colors={colors}
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

/** "2026-09-27 09:00" in local time, the format the "At" field edits. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalInput(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
  return valid ? date : null;
}

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

interface RoutineFormProps {
  colors: Colors;
  routine: Routine | null;
  onCancel(): void;
  onSubmit(routine: Routine): void;
}

function RoutineForm({ colors, routine, onCancel, onSubmit }: RoutineFormProps) {
  const original: RoutineSchedule = routine?.schedule ?? { kind: "cron", expression: "0 9 * * 1-5" };
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
  const [onceText, setOnceText] = useState(() => toLocalInput(original.kind === "once" ? new Date(original.at) : inAnHour()));
  // Presets rewrite the cron field; remounting it is how Paseo's CadenceEditor resets it too.
  const [cronKey, setCronKey] = useState(0);

  const once = schedule.kind === "once";
  const trimmedCron = cronText.trim();
  const presetValue = once ? ONCE : (CRON_PRESETS.find((preset) => preset.expression === trimmedCron)?.id ?? CUSTOM_CRON);
  const cronError = once ? null : validateCron(trimmedCron);
  const onceDate = once ? parseLocalInput(onceText) : null;
  const onceChanged = original.kind !== "once" || onceDate?.getTime() !== new Date(original.at).getTime();
  const onceError = !once ? null : !onceDate ? "Use YYYY-MM-DD HH:MM" : onceChanged && onceDate.getTime() <= Date.now() ? "Pick a time in the future" : null;
  const canSubmit = prompt.trim().length > 0 && !cronError && !onceError;

  const submit = () => {
    const firstLine = prompt.trim().split("\n")[0]!.slice(0, 60);
    const base: Routine = routine ?? { id: newRoutineId(), name: "", prompt: "", enabled: true, schedule, createdAt: new Date().toISOString() };
    onSubmit({ ...base, name: name.trim().slice(0, 80) || firstLine, prompt, schedule });
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
              options={[...CRON_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })), { label: "Once", value: ONCE }]}
              onValueChange={(value) => {
                if (value === ONCE) {
                  setSchedule({ kind: "once", at: (parseLocalInput(onceText) ?? inAnHour()).toISOString() });
                  return;
                }
                const preset = CRON_PRESETS.find((entry) => entry.id === value);
                if (!preset) return;
                setCronText(preset.expression);
                setCronKey((key) => key + 1);
                setSchedule({ kind: "cron", expression: preset.expression });
              }}
            />
            {once ? (
              <InputField colors={colors}
                key="once"
                label="At"
                hint={onceDate ? onceDate.toLocaleString() : "YYYY-MM-DD HH:MM"}
                error={onceError}
                initialValue={onceText}
                placeholder="2026-09-27 09:00"
                onChangeText={(text) => {
                  setOnceText(text);
                  const at = parseLocalInput(text);
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
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" onPress={onCancel} style={{ flex: 1 }} />
          <Button colors={colors} size="md" variant="default" label={routine ? "Save changes" : "Create routine"} disabled={!canSubmit} onPress={submit} style={{ flex: 1 }} />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}
