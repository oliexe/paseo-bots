import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { newPlaybookId, SOUL_MAX_BYTES, utf8Bytes, type Playbook } from "../../shared/bot";
import { parseTriggers } from "../../shared/playbooks";
import { memoryDeleteRpc, memoryListRpc, memoryReadRpc, memoryWriteRpc } from "../../shared/rpc";
import { useBotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import type { PanelProps } from "./BotPanel";
import { LibraryPicker } from "./LibraryPicker";
import { Alert, Button, CardNote, DrillRow, FormTextArea, InputField, SectionLink, SectionMeta, SheetActions, TextAreaField } from "./controls";
import { DailyLog, MemoryChanges } from "./MemoryActivity";

type Colors = PanelProps["colors"];

const kb = (bytes: number) => (bytes / 1000).toFixed(1);


function LocalOnly({ colors, what }: { colors: Colors; what: string }) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Alert colors={colors} description={`${what} live on the host that stores this bot, so they only apply while the bot runs there.`} />
    </View>
  );
}

// ---------------------------------------------------------------- soul

/** Paseo's "Append system prompt": a row with Edit that opens a sheet with the text, Reset and Save. */
export function SoulSection({ colors, bot, onPatch }: PanelProps) {
  const [editing, setEditing] = useState(false);
  const bytes = utf8Bytes(bot.soul);
  return (
    <>
      <SettingsSection title="Instructions" info="Comes right after the bot's identity in the system prompt and outranks memory and skills.">
        <SettingsCard>
          <SettingsAction label="Standing instructions" hint="How the bot behaves in every chat" actionLabel="Edit" onPress={() => setEditing(true)} />
          <SettingsRow
            label="Size"
            hint={bytes ? `${kb(bytes)} of ${SOUL_MAX_BYTES / 1000} KB` : "Empty"}
            error={bytes > SOUL_MAX_BYTES ? `Over the ${SOUL_MAX_BYTES / 1000} KB limit` : null}
          />
        </SettingsCard>
      </SettingsSection>
      {editing ? (
        <SoulSheet
          colors={colors}
          saved={bot.soul}
          onClose={() => setEditing(false)}
          onSave={(soul) => {
            onPatch({ soul });
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}

function SoulSheet({ colors, saved, onClose, onSave }: { colors: Colors; saved: string; onClose(): void; onSave(soul: string): void }) {
  const [draft, setDraft] = useState(saved);
  const bytes = utf8Bytes(draft);
  const changed = draft !== saved;
  return (
    <Modal title="Standing instructions" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <FormTextArea
          colors={colors}
          accessibilityLabel="Standing instructions"
          value={draft}
          onChangeText={setDraft}
          minHeight={320}
          placeholder="You manage my email. Draft replies in my voice; never send without asking."
        />
        <SheetActions
          leading={
            <SectionMeta colors={colors} text={`${kb(bytes)} / ${SOUL_MAX_BYTES / 1000} KB`} tone={bytes > SOUL_MAX_BYTES ? "danger" : bytes > SOUL_MAX_BYTES * 0.8 ? "warning" : undefined} />
          }
        >
          <Button colors={colors} variant="ghost" label="Reset" disabled={!changed} onPress={() => setDraft(saved)} />
          <Button colors={colors} variant="default" label="Save" disabled={!changed} onPress={() => onSave(draft)} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- skills

export function SkillsSection(props: PanelProps) {
  const host = useBotHost(props.bot.hostId, props.localHost);
  return (
    <>
      {!host.isLocal ? <LocalOnly colors={props.colors} what="Skills" /> : null}
      <LibraryPicker {...props} kind="skill" title="Skills" info="Switched-on skills are listed in the bot's prompt and read when a task needs them. Add and edit skills in Skills & Tools." />
    </>
  );
}

// ---------------------------------------------------------------- memory

const TOPIC_NAME = /^[A-Za-z0-9 ._-]+$/;
const MEMORY_LINES = 200;
const MEMORY_BYTES = 24_000;

export function MemorySection({ colors, bot, localHost }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const list = useRpc(memoryListRpc);
  const write = useRpc(memoryWriteRpc);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [topicKey, setTopicKey] = useState(0);
  const files = useQuery({ queryKey: ["paseo-bots", "memory", bot.id], queryFn: () => list({ botId: bot.id }), refetchInterval: 20_000 });
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ["paseo-bots", "memory", bot.id] }), queryClient.invalidateQueries({ queryKey: ["paseo-bots", "memory-journal", bot.id] })]);

  const data = files.data;
  const over = data ? data.injectedLines > MEMORY_LINES || data.injectedBytes > MEMORY_BYTES : false;
  const topicName = topic.trim().replace(/\.md$/, "");
  const topicError = topicName && !TOPIC_NAME.test(topicName) ? "Use letters, numbers, spaces, dots and dashes" : null;

  return (
    <>
      {!host.isLocal ? <LocalOnly colors={colors} what="Memory files" /> : null}
      <SettingsSection title="Files" info="The bot updates these itself as it learns; edit them to correct or add facts. MEMORY.md is loaded into every chat, topic files are read on demand.">
        <SettingsCard>
          <SettingsRow
            label="Loaded into every chat"
            hint={data ? `${data.injectedLines} of ${MEMORY_LINES} lines · ${kb(data.injectedBytes)} of ${MEMORY_BYTES / 1000} KB` : "Loading..."}
            error={over ? "Over the budget, so the end of MEMORY.md is left out" : null}
          />
          {(data?.files ?? [{ name: "MEMORY.md", bytes: 0, lines: 0, topic: false }]).map((file) => (
            <DrillRow
              key={file.name}
              colors={colors}
              label={file.topic ? `memory/${file.name}` : file.name}
              hint={data ? `${file.lines} lines · ${kb(file.bytes)} KB` : "Loading..."}
              onPress={() => setOpen(file.name)}
            />
          ))}
          {data ? <SettingsRow label="Folder" hint={data.folder} /> : null}
        </SettingsCard>
      </SettingsSection>
      <MemoryChanges colors={colors} bot={bot} onUndone={() => void refresh()} />
      <DailyLog colors={colors} bot={bot} />
      <SettingsSection title="New topic file">
        <SettingsCard>
          <InputField colors={colors} key={topicKey} label="Name" hint="Letters, numbers, spaces, dots and dashes" error={topicError} initialValue="" placeholder="projects" onChangeText={setTopic} />
          <SettingsAction
            label="Create the topic file"
            actionLabel="Create"
            disabled={!topicName || !!topicError}
            onPress={() => {
              const name = `${topicName}.md`;
              void write({ botId: bot.id, name, text: `# ${topicName}\n` }).then(() => {
                setTopic("");
                setTopicKey((key) => key + 1);
                setOpen(name);
                void refresh();
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>
      {open ? <MemorySheet colors={colors} botId={bot.id} name={open} onChanged={() => void refresh()} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** One memory file in a sheet. Closing with unsaved edits asks before discarding them. */
function MemorySheet({ colors, botId, name, onChanged, onClose }: { colors: Colors; botId: string; name: string; onChanged(): void; onClose(): void }) {
  const read = useRpc(memoryReadRpc);
  const write = useRpc(memoryWriteRpc);
  const remove = useRpc(memoryDeleteRpc);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const topic = name !== "MEMORY.md";
  const label = topic ? `memory/${name}` : name;
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    let cancelled = false;
    void read({ botId, name })
      .then(({ text: loaded }) => {
        if (cancelled) return;
        setText(loaded);
        setSaved(loaded);
      })
      .catch((error: unknown) => !cancelled && toastRef.current.error(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [botId, name, read]);

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard changes", message: `Discard your changes to ${label}?`, confirmLabel: "Discard", destructive: true }))) return;
    onClose();
  };

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try {
      // Bots edit their memory themselves; don't overwrite a change made since it was opened.
      const current = (await read({ botId, name })).text;
      if (current !== saved && current !== text) {
        toast.error("The bot changed this file since you opened it. Close it and open it again.");
        return;
      }
      await write({ botId, name, text });
      setSaved(text);
      onChanged();
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    const confirmed = await confirmDialog({ title: "Delete topic file", message: `Delete ${label}? This cannot be undone.`, confirmLabel: "Delete", destructive: true });
    if (!confirmed) return;
    await remove({ botId, name });
    onChanged();
    onClose();
  };

  return (
    <Modal title={label} open onOpenChange={(value) => !value && void close()}>
      <Modal.Content>
        {text === null ? (
          <SettingsCard>
            <View style={{ minHeight: 320, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          </SettingsCard>
        ) : (
          <FormTextArea colors={colors} monospace accessibilityLabel={`${label} contents`} value={text} onChangeText={setText} minHeight={320} placeholder={"- Prefers short replies\n- Works Mon-Fri, CET"} />
        )}
        <SheetActions leading={topic ? <Button colors={colors} variant="ghost" label="Delete" icon="Trash2" onPress={() => void destroy()} /> : null}>
          <Button colors={colors} variant="ghost" label="Reset" disabled={!dirty || saving} onPress={() => setText(saved)} />
          <Button colors={colors} variant="default" label={saving ? "Saving..." : "Save"} disabled={!dirty || saving} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- playbooks

/** OpenMausBot's playbooks: step-by-step guidance a chat gets when its first message mentions a trigger. */
export function PlaybooksSection({ colors, bot, onPatch }: PanelProps) {
  const [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const save = (playbook: Playbook) => {
    onPatch({ playbooks: bot.playbooks.some((entry) => entry.id === playbook.id) ? bot.playbooks.map((entry) => (entry.id === playbook.id ? playbook : entry)) : [...bot.playbooks, playbook] });
    setEditing(null);
  };
  const remove = async (playbook: Playbook) => {
    if (!(await confirmDialog({ title: "Delete playbook", message: `Delete "${playbook.name}"? This cannot be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    onPatch({ playbooks: bot.playbooks.filter((entry) => entry.id !== playbook.id) });
    setEditing(null);
  };
  return (
    <>
      <SettingsSection
        title="Playbooks"
        info="Steps for a kind of job. A chat gets a playbook when its first message mentions one of the playbook's trigger words, up to three at a time."
        trailing={<SectionLink colors={colors} label="New playbook" onPress={() => setEditing("new")} />}
      >
        <SettingsCard>
          {bot.playbooks.length === 0 ? <CardNote colors={colors} text="No playbooks yet" /> : null}
          {bot.playbooks.map((playbook) => (
            <DrillRow
              key={playbook.id}
              colors={colors}
              label={playbook.name || "Untitled playbook"}
              hint={playbook.triggers.length ? `When a chat mentions ${playbook.triggers.join(", ")}` : "No trigger words, so no chat gets it"}
              onPress={() => setEditing(playbook)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      {editing ? <PlaybookSheet colors={colors} playbook={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={save} onDelete={editing === "new" ? undefined : () => void remove(editing)} /> : null}
    </>
  );
}

function PlaybookSheet({ colors, playbook, onClose, onSave, onDelete }: { colors: Colors; playbook: Playbook | null; onClose(): void; onSave(playbook: Playbook): void; onDelete?: () => void }) {
  const [name, setName] = useState(playbook?.name ?? "");
  const [triggers, setTriggers] = useState(playbook?.triggers.join(", ") ?? "");
  const [instructions, setInstructions] = useState(playbook?.instructions ?? "");
  const parsed = parseTriggers(triggers);
  const canSave = !!name.trim() && parsed.length > 0 && !!instructions.trim();
  return (
    <Modal title={playbook ? "Edit playbook" : "New playbook"} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" initialValue={name} placeholder="Month-end close" onChangeText={setName} />
            <InputField colors={colors} label="Trigger words" hint="Comma-separated words or phrases" initialValue={triggers} placeholder="month end, close the books" onChangeText={setTriggers} />
            <TextAreaField colors={colors} label="Steps" hint="Markdown. The bot follows these when a chat matches." value={instructions} onChangeText={setInstructions} minHeight={240} placeholder={"1. Export last month's transactions.\n2. Reconcile them against the bank statement.\n3. ..."} />
          </SettingsCard>
        </View>
        <SheetActions leading={onDelete ? <Button colors={colors} variant="ghost" label="Delete" icon="Trash2" onPress={onDelete} /> : null}>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          <Button
            colors={colors}
            variant="default"
            label="Save"
            disabled={!canSave}
            onPress={() => onSave({ id: playbook?.id ?? newPlaybookId(), name: name.trim().slice(0, 80), triggers: parsed, instructions })}
          />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
