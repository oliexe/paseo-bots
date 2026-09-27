import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { dayName, journalSource, journalSummary } from "../../shared/activity";
import type { Bot } from "../../shared/bot";
import { memoryJournalRpc, memoryLogDeleteRpc, memoryLogRpc, memoryUndoRpc, type JournalRow } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { ToolCallDetailsContent } from "../chat/stream/details";
import { confirmDialog, errorText, MONO_FONT, MONO_PROPS } from "../native";
import { code, codeLine, ui } from "../typography";
import type { PanelProps } from "./BotPanel";
import { Button, CardNote, DrillRow, SheetActions } from "./controls";

type Colors = PanelProps["colors"];

const SHOWN = 20;
const journalKey = (botId: string) => ["paseo-bots", "memory-journal", botId];
const logKey = (botId: string) => ["paseo-bots", "memory-log", botId];

// OpenMausBot's memory "Changes" card and daily log, in the bot's Memory section.

export function MemoryChanges({ colors, bot, onUndone }: { colors: Colors; bot: Bot; onUndone(): void }) {
  const journal = useRpc(memoryJournalRpc);
  const query = useQuery({ queryKey: journalKey(bot.id), queryFn: () => journal({ botId: bot.id }), refetchInterval: 20_000 });
  const [open, setOpen] = useState<JournalRow | null>(null);
  const rows = (query.data?.entries ?? []).slice(0, SHOWN);
  return (
    <>
      <SettingsSection title="Changes" info="Every change to these files, by the bot or by you. Undo puts a file back the way it was before that change.">
        <SettingsCard>
          {rows.length === 0 ? <CardNote colors={colors} text={query.isLoading ? "Loading..." : "No changes yet"} loading={query.isLoading} /> : null}
          {rows.map((row) => (
            <DrillRow key={row.id} colors={colors} label={journalSummary(row, bot.name)} hint={`${relativeTime(row.at)} · ${journalSource(row)}`} onPress={() => setOpen(row)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      {open ? <ChangeSheet colors={colors} bot={bot} row={open} onUndone={onUndone} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** One change: its diff, laid out like an edit tool call, and Undo. */
function ChangeSheet({ colors, bot, row, onUndone, onClose }: { colors: Colors; bot: Bot; row: JournalRow; onUndone(): void; onClose(): void }) {
  const undo = useRpc(memoryUndoRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const file = row.file === "MEMORY.md" ? row.file : `memory/${row.file}`;

  const revert = async () => {
    setBusy(true);
    try {
      await undo({ botId: bot.id, id: row.id });
      await queryClient.invalidateQueries({ queryKey: journalKey(bot.id) });
      onUndone();
      onClose();
    } catch (error) {
      toast.error(`Couldn't undo: ${errorText(error)}`);
      setBusy(false);
    }
  };

  return (
    <Modal title={journalSummary(row, bot.name)} open onOpenChange={(value) => !value && !busy && onClose()}>
      <Modal.Content>
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{`${file} · ${relativeTime(row.at)} · ${journalSource(row)}`}</Text>
        {row.diff ? (
          <ToolCallDetailsContent colors={colors} detail={{ type: "edit", filePath: file, unifiedDiff: row.diff }} maxHeight={420} />
        ) : (
          <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{row.kind === "deleted" ? "The file was deleted." : "Too large to show."}</Text>
        )}
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Close" disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="default" label={busy ? "Undoing..." : "Undo"} disabled={!row.canUndo || busy} onPress={() => void revert()} />
        </SheetActions>
        {!row.canUndo ? <Text style={{ fontSize: ui(13), color: colors.foregroundMuted }}>The earlier version was too large to keep, so this can't be undone.</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

export function DailyLog({ colors, bot }: { colors: Colors; bot: Bot }) {
  const log = useRpc(memoryLogRpc);
  const query = useQuery({ queryKey: logKey(bot.id), queryFn: () => log({ botId: bot.id }), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const days = (query.data?.days ?? []).slice(0, 14);
  const now = new Date();
  return (
    <>
      <SettingsSection title="Daily log" info="After each finished turn the app adds a line: what the bot said and which tools it used. It isn't loaded into chats; the bot looks things up in it with search_chats.">
        <SettingsCard>
          {days.length === 0 ? <CardNote colors={colors} text={query.isLoading ? "Loading..." : "No entries yet"} loading={query.isLoading} /> : null}
          {days.map((entry) => (
            <DrillRow key={entry.day} colors={colors} label={dayName(entry.day, now)} hint={`${entry.lines} ${entry.lines === 1 ? "entry" : "entries"}`} onPress={() => setOpen(entry.day)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      {open ? <LogSheet colors={colors} bot={bot} day={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** One day's log, read-only; Delete removes the day. */
function LogSheet({ colors, bot, day, onClose }: { colors: Colors; bot: Bot; day: string; onClose(): void }) {
  const log = useRpc(memoryLogRpc);
  const remove = useRpc(memoryLogDeleteRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const text = useQuery({ queryKey: [...logKey(bot.id), day], queryFn: () => log({ botId: bot.id, day }) });

  const destroy = async () => {
    const label = dayName(day, new Date());
    if (!(await confirmDialog({ title: "Delete log", message: `Delete the log for ${label}? This cannot be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    try {
      await remove({ botId: bot.id, day });
      await queryClient.invalidateQueries({ queryKey: logKey(bot.id) });
      onClose();
    } catch (error) {
      toast.error(`Couldn't delete: ${errorText(error)}`);
    }
  };

  return (
    <Modal title={`memory/log/${day}.md`} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <View style={{ padding: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, minHeight: 120 }}>
          {text.data ? (
            <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
              {text.data.text?.trim() || "This day's log is empty."}
            </Text>
          ) : (
            <ActivityIndicator size="small" color={colors.foregroundMuted} />
          )}
        </View>
        <SheetActions leading={<Button colors={colors} variant="ghost" label="Delete" icon="Trash2" onPress={() => void destroy()} />}>
          <Button colors={colors} variant="default" label="Close" onPress={onClose} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
