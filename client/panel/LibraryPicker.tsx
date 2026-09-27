import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { Bot } from "../../shared/bot";
import { mcpServerTested, mcpTarget, setBotUses, type LibraryKind } from "../../shared/library";
import { openLibrary } from "../navigation";
import type { PanelProps } from "./BotPanel";
import { CardNote, PressableRow, RowText, SectionLink, Switch } from "./controls";

interface LibraryPickerProps extends Pick<PanelProps, "colors" | "bot" | "library" | "onPatch"> {
  kind: LibraryKind;
  title: string;
  info: string;
}

/**
 * The library's skills or MCP servers with a switch each for this bot, like
 * OpenMausBot's per-bot Access cards. Items are added and edited on the
 * Skills & Tools page; a row opens its page there.
 */
export function LibraryPicker({ colors, bot, library, onPatch, kind, title, info }: LibraryPickerProps) {
  const items =
    kind === "skill"
      ? library.skills.map((skill) => ({
          id: skill.id,
          label: skill.id,
          hint: skill.description || skill.source,
          enabled: skill.enabled && skill.reviewedSha !== null,
          offHint: skill.reviewedSha === null ? "Needs review in Skills & Tools" : "Turned off in Skills & Tools",
        }))
      : library.mcpServers.map((server) => ({
          id: server.id,
          label: server.name,
          hint: server.description || mcpTarget(server.config),
          enabled: server.enabled,
          offHint: mcpServerTested(server) ? "Turned off in Skills & Tools" : "Needs a test in Skills & Tools",
        }));
  const used = kind === "skill" ? bot.skillIds : bot.mcpServerIds;
  const toggle = (id: string, on: boolean) => {
    const next: Bot = setBotUses(bot, kind, id, on);
    onPatch(kind === "skill" ? { skillIds: next.skillIds } : { mcpServerIds: next.mcpServerIds });
  };
  const noun = kind === "skill" ? "skills" : "MCP servers";

  return (
    <SettingsSection title={title} info={info} trailing={<SectionLink colors={colors} icon="ArrowUpRight" label="Skills & Tools" onPress={() => openLibrary()} />}>
      <SettingsCard>
        {items.length === 0 ? <CardNote colors={colors} text={`No ${noun} in Skills & Tools yet`} /> : null}
        {items.map((item) => (
          <PressableRow key={item.id} colors={colors} accessibilityLabel={`Open ${item.label} in Skills & Tools`} onPress={() => openLibrary({ kind, id: item.id })}>
            {({ hovered }) => (
              <>
                <RowText colors={colors} label={item.label} hint={item.enabled ? item.hint : item.offHint} hintLines={2} />
                <Switch colors={colors} label={`Use ${item.label}`} value={item.enabled && used.includes(item.id)} disabled={!item.enabled} onValueChange={(on) => toggle(item.id, on)} />
                <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
              </>
            )}
          </PressableRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
