import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { skillImportRpc, skillWriteRpc } from "../../shared/rpc";
import { parseSkillFrontmatter, parseSkillSource, sanitizeSkillName } from "../../shared/skills";
import { Button, FormTextArea, InputField, SheetActions, SheetFooter, TextAreaField } from "../panel/controls";
import { ui } from "../typography";
import { errorText } from "../native";

type Colors = PluginTheme["colors"];

export interface SavedSkill {
  id: string;
  description: string;
  source: string;
}


function ErrorLine({ colors, text, tone = "error" }: { colors: Colors; text: string | null; tone?: "error" | "warning" }) {
  return text ? (
    <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: tone === "warning" ? colors.statusWarning : colors.statusDanger, marginLeft: 4 }}>
      {text}
    </Text>
  ) : null;
}

/** Fetches one skill, or every skill in a repository or folder, into the library. */
export function ImportSkillsSheet({ colors, onClose, onImported }: { colors: Colors; onClose(): void; onImported(skills: SavedSkill[]): void }) {
  const importSkills = useRpc(skillImportRpc);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let sourceError: string | null = null;
  try {
    if (source.trim()) parseSkillSource(source);
  } catch (caught) {
    sourceError = errorText(caught);
  }
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { skills } = await importSkills({ source: source.trim() });
      onImported(skills);
    } catch (caught) {
      setError(`Couldn't import: ${errorText(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Import skills" open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <SettingsSection title="From GitHub or a link" info="A repository or folder brings in every SKILL.md inside it (up to 30). Importing a skill that's already here updates it.">
          <SettingsCard>
            <InputField colors={colors} label="Source" hint='"owner/repo", a GitHub folder or a SKILL.md link' error={sourceError} initialValue="" placeholder="anthropics/skills/skills/pdf" onChangeText={setSource} />
          </SettingsCard>
          <ErrorLine colors={colors} text={error} />
        </SettingsSection>
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" disabled={busy} onPress={onClose} style={{ flex: 1 }} />
          <Button colors={colors} size="md" variant="default" label={busy ? "Importing..." : "Import"} loading={busy} disabled={!source.trim() || !!sourceError} onPress={() => void run()} style={{ flex: 1 }} />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/** SKILL.md with the frontmatter agents read: a name that matches the folder and a one-line description. */
export function skillMarkdown(id: string, description: string, body: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${id}\ndescription: ${line}\n---\n\n${body.trim()}\n`;
}

/** Writes a new skill here: a name, when to use it, and its instructions. */
export function NewSkillSheet({ colors, taken, onClose, onCreated }: { colors: Colors; taken: string[]; onClose(): void; onCreated(skill: SavedSkill): void }) {
  const write = useRpc(skillWriteRpc);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = name.trim() ? sanitizeSkillName(name) : "";
  const nameError = id && taken.includes(id) ? `"${id}" is already in the library` : null;
  const nameHint = id && id !== name.trim() ? `Saved as "${id}"` : "Lowercase letters, numbers and dashes";
  const canCreate = !!id && !nameError && !!description.trim() && !!body.trim();

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await write({ id, text: skillMarkdown(id, description, body) });
      onCreated({ id, description: saved.description, source: "" });
    } catch (caught) {
      setError(`Couldn't save: ${errorText(caught)}`);
      setBusy(false);
    }
  };

  return (
    <Modal title="New skill" open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" hint={nameHint} error={nameError} initialValue="" placeholder="weekly-report" onChangeText={setName} />
            <InputField colors={colors} label="When to use it" hint="Bots see this line and decide from it" initialValue="" placeholder="Use when asked for the weekly status report" onChangeText={setDescription} />
            <TextAreaField
              colors={colors}
              label="Instructions"
              hint="Markdown. Bots read it before a task the skill covers."
              value={body}
              onChangeText={setBody}
              minHeight={240}
              placeholder={"# Weekly report\n\n1. Collect the merged pull requests from the last 7 days.\n2. ..."}
            />
          </SettingsCard>
        </View>
        <ErrorLine colors={colors} text={error} />
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" disabled={busy} onPress={onClose} style={{ flex: 1 }} />
          <Button colors={colors} size="md" variant="default" label="Create skill" loading={busy} disabled={!canCreate} onPress={() => void create()} style={{ flex: 1 }} />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/** Edits SKILL.md as text; the description is read back from its frontmatter. */
export function EditSkillSheet({ colors, id, saved, onClose, onSaved }: { colors: Colors; id: string; saved: string; onClose(): void; onSaved(description: string): void }) {
  const write = useRpc(skillWriteRpc);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = draft !== saved;
  const meta = parseSkillFrontmatter(draft);
  const warning = !meta.description ? "Add a description: line to the frontmatter so bots know when to use it" : meta.name && meta.name !== id ? `The name in the frontmatter should be "${id}"` : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await write({ id, text: draft });
      onSaved(result.description);
    } catch (caught) {
      setError(`Couldn't save: ${errorText(caught)}`);
      setBusy(false);
    }
  };

  return (
    <Modal title={`${id} · SKILL.md`} open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content>
        <FormTextArea colors={colors} monospace accessibilityLabel="SKILL.md" value={draft} onChangeText={setDraft} autoCapitalize="none" autoCorrect={false} minHeight={360} />
        {error ? <ErrorLine colors={colors} text={error} /> : <ErrorLine colors={colors} text={warning} tone="warning" />}
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Reset" disabled={!changed || busy} onPress={() => setDraft(saved)} />
          <Button colors={colors} variant="default" label="Save" loading={busy} disabled={!changed} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
