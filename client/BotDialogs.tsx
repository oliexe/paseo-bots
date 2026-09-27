import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Bot, BotAvatar, Preset } from "../shared/bot";
import { exportBotRpc } from "../shared/rpc";
import { BOT_TEMPLATES, type BotTemplate } from "../shared/templates";
import { Avatar } from "./Avatar";
import { errorText, MONO_FONT, MONO_PROPS, nativeTokens, useHover } from "./native";
import { Button, FormTextArea, SheetActions } from "./panel/controls";
import type { MenuEntry } from "./ui/Menu";
import { code, codeLine, ui } from "./typography";

type Colors = PluginTheme["colors"];

// ------------------------------------------------------------------ new bot

export function NewBotDialog({
  colors,
  presets,
  onClose,
  onCreate,
  onImport,
}: {
  colors: Colors;
  presets: readonly Preset[];
  onClose(): void;
  onCreate(start?: { template?: BotTemplate; preset?: Preset }): void;
  onImport(json: string): Promise<void>;
}) {
  const [json, setJson] = useState("");
  const [importing, setImporting] = useState(false);
  const toast = useToast();
  return (
    <Modal title="New bot" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsSection title="Start from">
          <SettingsCard>
            <StartRow colors={colors} label="Blank bot" hint="Set everything up yourself in the settings panel." onPress={() => onCreate()} />
            {BOT_TEMPLATES.map((template) => (
              <StartRow key={template.id} colors={colors} label={template.title} hint={template.description} avatar={{ seed: template.avatarSeed }} onPress={() => onCreate({ template })} />
            ))}
          </SettingsCard>
        </SettingsSection>
        {presets.length ? (
          <SettingsSection title="Your presets" info="Bots you saved as presets from their menu. Manage them in Settings, Plugins, paseo-bots.">
            <SettingsCard>
              {presets.map((preset) => (
                <StartRow key={preset.id} colors={colors} label={preset.name} hint={preset.title || preset.description} avatar={preset.avatar} onPress={() => onCreate({ preset })} />
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}
        <SettingsSection title="Import" info="Paste a bot or team file from paseo-bots. Routines arrive paused, skills need a review and secrets must be filled in again.">
          <FormTextArea
            colors={colors}
            monospace
            accessibilityLabel="Bot or team file"
            value={json}
            onChangeText={setJson}
            autoCapitalize="none"
            autoCorrect={false}
            minHeight={120}
            placeholder='{"format": "paseo-bots", …}'
          />
          <SheetActions>
            <Button
              colors={colors}
              variant="default"
              label={importing ? "Importing..." : "Import"}
              loading={importing}
              disabled={!json.trim()}
              onPress={() => {
                setImporting(true);
                void onImport(json)
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setImporting(false));
              }}
            />
          </SheetActions>
        </SettingsSection>
      </Modal.Content>
    </Modal>
  );
}

/** A whole-row pressable settings row (settings card geometry: 16 padding, 14/12 text). */
function StartRow({ colors, label, hint, avatar, onPress }: { colors: Colors; label: string; hint: string; avatar?: Partial<BotAvatar> & { seed: string }; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Create ${label}`}
      accessibilityHint={hint}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: pressed || hovered ? colors.surface2 : "transparent",
      })}
    >
      {avatar ? (
        <Avatar avatar={avatar} size={28} />
      ) : (
        <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 }}>
          <Icon name="Plus" size={14} color={colors.foregroundMuted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foreground }}>
          {label}
        </Text>
        {hint ? (
          <Text numberOfLines={2} style={{ marginTop: 4, fontSize: ui(12), color: colors.foregroundMuted }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

// ------------------------------------------------------------------ rename

interface RenameDialogProps {
  colors: Colors;
  title: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onClose(): void;
  onSubmit(value: string): Promise<void> | void;
}

/**
 * Paseo's AdaptiveRenameModal (components/rename-modal.tsx): the current name selected
 * in one input, the error inline, Cancel and Rename side by side. It stays open on errors.
 */
export function RenameDialog({ colors, title, initialValue, placeholder, submitLabel = "Rename", onClose, onSubmit }: RenameDialogProps) {
  const [draft, setDraft] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const invalid = !draft.trim();
  const submitDisabled = pending || draft === initialValue || invalid;

  const submit = async () => {
    if (pending || draft === initialValue) return;
    if (invalid) {
      setError("Name is required");
      return;
    }
    try {
      setPending(true);
      await onSubmit(draft.trim());
      setPending(false);
      onClose();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error && err.message ? err.message : "Unable to save");
    }
  };
  const cancel = () => {
    if (!pending) onClose();
  };

  return (
    <Modal title={title} open onOpenChange={(open) => !open && cancel()}>
      <Modal.Content>
        <View style={{ gap: 12, paddingBottom: 8 }}>
          <TextInput
            accessibilityLabel={title}
            defaultValue={initialValue}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.foregroundMuted}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            style={{
              backgroundColor: colors.surface0,
              color: colors.foreground,
              paddingVertical: 12,
              paddingHorizontal: 12,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: colors.border,
              fontSize: ui(14),
            }}
          />
          {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: ui(14) }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <DialogButton colors={colors} label="Cancel" disabled={pending} onPress={cancel} />
            <DialogButton colors={colors} label={pending ? "Saving..." : submitLabel} primary disabled={submitDisabled} onPress={() => void submit()} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Paseo's Button size="sm": secondary (surface3) or default (accent). */
function DialogButton({ colors, label, primary, disabled, onPress }: { colors: Colors; label: string; primary?: boolean; disabled?: boolean; onPress(): void }) {
  const fill = primary ? colors.accent : nativeTokens(colors).surface3;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: fill,
        backgroundColor: fill,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: ui(14), color: primary ? colors.accentForeground : colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------ menus

export interface BotMenuActions {
  bot: Bot;
  /** Set when the host exposes navigation and the bot's workspace is known. */
  onOpenInPaseo?: () => void;
  onOpenSettings(): void;
  onTogglePin(): void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename(): void;
  onDuplicate(): Promise<void>;
  onExport(): void;
  onCopyId(): void;
  onSaveAsPreset(): void;
  onToggleArchive(): void;
  onDelete(): Promise<void>;
}

/** The bot menu, after Paseo's project menu (sidebar-workspace-list.tsx ProjectMenuItems). */
export function botMenuEntries(actions: BotMenuActions): MenuEntry[] {
  const { bot } = actions;
  const entries: MenuEntry[] = [{ label: "Open bot settings", icon: "Settings", onSelect: actions.onOpenSettings }];
  if (actions.onOpenInPaseo) entries.push({ label: "Open in Paseo", icon: "ExternalLink", onSelect: actions.onOpenInPaseo });
  entries.push({ label: bot.pinned ? "Unpin" : "Pin to top", icon: bot.pinned ? "PinOff" : "Pin", onSelect: actions.onTogglePin });
  if (actions.onMoveUp || actions.onMoveDown) {
    entries.push({ label: "Move up", icon: "ArrowUp", disabled: !actions.onMoveUp, onSelect: () => actions.onMoveUp?.() });
    entries.push({ label: "Move down", icon: "ArrowDown", disabled: !actions.onMoveDown, onSelect: () => actions.onMoveDown?.() });
  }
  entries.push(
    { label: "Rename bot", icon: "Pencil", onSelect: actions.onRename },
    { label: "Duplicate", icon: "CopyPlus", pendingLabel: "Duplicating...", onSelect: actions.onDuplicate },
    { label: "Save as preset", icon: "BookmarkPlus", onSelect: actions.onSaveAsPreset },
    { label: "Export", icon: "Share", onSelect: actions.onExport },
    { label: "Copy bot ID", icon: "Copy", onSelect: actions.onCopyId },
    { kind: "separator" },
    { label: bot.archived ? "Unarchive bot" : "Archive bot", icon: bot.archived ? "ArchiveRestore" : "Archive", onSelect: actions.onToggleArchive },
    { label: "Delete bot", icon: "Trash2", destructive: true, pendingLabel: "Deleting...", onSelect: actions.onDelete },
  );
  return entries;
}

export interface ChatMenuActions {
  pinned: boolean;
  onCopyPath(): void;
  onCopyId(): void;
  onTogglePin(): void;
  /** Present in manual order; undefined at an edge. `null` hides the pair (pinned chats, activity order). */
  move: { up?: () => void; down?: () => void } | null;
  onOpenInPaseo?: () => void;
  onArchive(): Promise<void>;
}

/** The chat menu, after Paseo's workspace menu (sidebar/sidebar-workspace-menu.tsx). */
export function chatMenuEntries(actions: ChatMenuActions): MenuEntry[] {
  const entries: MenuEntry[] = [
    { label: "Copy path", icon: "Copy", onSelect: actions.onCopyPath },
    { label: "Copy chat ID", icon: "Copy", onSelect: actions.onCopyId },
    { label: actions.pinned ? "Unpin" : "Pin to top", icon: actions.pinned ? "PinOff" : "Pin", onSelect: actions.onTogglePin },
  ];
  if (actions.move) {
    entries.push({ label: "Move up", icon: "ArrowUp", disabled: !actions.move.up, onSelect: () => actions.move?.up?.() });
    entries.push({ label: "Move down", icon: "ArrowDown", disabled: !actions.move.down, onSelect: () => actions.move?.down?.() });
  }
  if (actions.onOpenInPaseo) entries.push({ label: "Open in Paseo", icon: "ExternalLink", onSelect: actions.onOpenInPaseo });
  entries.push({ label: "Archive", icon: "Archive", pendingLabel: "Archiving...", onSelect: actions.onArchive });
  return entries;
}

// ------------------------------------------------------------------ export

export function ExportDialog({ colors, bot, onClose }: { colors: Colors; bot: Bot; onClose(): void }) {
  const exportBot = useRpc(exportBotRpc);
  const toast = useToast();
  const [includeMemory, setIncludeMemory] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setJson(null);
    exportBot({ bot, includeMemory })
      .then((result) => !cancelled && setJson(result.json))
      .catch((error: unknown) => toast.error(errorText(error)));
    return () => {
      cancelled = true;
    };
    // The bot is a snapshot for this dialog; rebuild only when the memory choice changes.
  }, [includeMemory]);
  return (
    <Modal title={`Export ${bot.name}`} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsSwitch
            label="Include memory"
            hint="MEMORY.md and topic files. Leave off when sharing with someone else."
            value={includeMemory}
            onValueChange={setIncludeMemory}
          />
          <SettingsAction
            label="Copy the bot file"
            hint={json ? `${(json.length / 1000).toFixed(1)} KB · host, folder, tool grants, secrets and chats aren't included.` : "Building..."}
            actionLabel="Copy"
            disabled={!json}
            onPress={() => void copyText(json!).then(() => toast.show("Bot file copied", { variant: "success" }))}
          />
        </SettingsCard>
        <Text {...MONO_PROPS} selectable numberOfLines={16} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foregroundMuted }}>
          {json ?? ""}
        </Text>
      </Modal.Content>
    </Modal>
  );
}
