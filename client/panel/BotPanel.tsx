import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { botProblems, type Bot, type HistoryEntry, type Library } from "../../shared/bot";
import { useBotHost, type LocalHost } from "../data";
import { nativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { AccessSection, ModelSection, PermissionsSection } from "./AgentSections";
import { Alert, SearchField, useCompact } from "./controls";
import { IdentitySection } from "./IdentitySection";
import { MemorySection, SkillsSection, SoulSection } from "./KnowledgeSections";
import { HistorySection, OverviewSection, UsageSection } from "./OverviewSections";
import { RoutinesSection } from "./RoutinesSection";

type Colors = PluginTheme["colors"];

export type SectionId = "overview" | "identity" | "soul" | "skills" | "memory" | "routines" | "access" | "model" | "permissions" | "history" | "usage";

interface SectionEntry {
  id: SectionId;
  label: string;
  icon: string;
  /** Setting names inside the section; search matches and lists them. */
  rows: string[];
  keywords: string;
}

// OpenMausBot's order (bot-settings/sections.ts), minus sections Paseo has no equivalent for,
// grouped like Paseo's settings sidebar.
const GROUPS: { label: string; sections: SectionEntry[] }[] = [
  {
    label: "Bot",
    sections: [
      { id: "overview", label: "Overview", icon: "LayoutDashboard", rows: ["Set up with the bot", "System prompt"], keywords: "summary setup prompt preview tokens" },
      { id: "identity", label: "Identity", icon: "IdCard", rows: ["Avatar", "Colour", "Shape", "Image URL", "Name", "Title", "Blurb"], keywords: "description picture color face" },
      { id: "soul", label: "Soul", icon: "ScrollText", rows: ["Standing instructions"], keywords: "system prompt soul behaviour behavior" },
    ],
  },
  {
    label: "Knowledge",
    sections: [
      { id: "skills", label: "Skills", icon: "Puzzle", rows: ["Library skills"], keywords: "skill github SKILL.md library" },
      { id: "memory", label: "Memory", icon: "Brain", rows: ["MEMORY.md", "Topic files", "Changes", "Daily log", "New topic file"], keywords: "memory notes remember undo journal log" },
    ],
  },
  {
    label: "Automation",
    sections: [{ id: "routines", label: "Routines", icon: "CalendarClock", rows: ["New routine", "Cadence", "Run now"], keywords: "schedule routine daily interval cron automation" }],
  },
  {
    label: "Agent",
    sections: [
      { id: "access", label: "Access", icon: "KeyRound", rows: ["Working folder", "Paseo tools", "MCP servers", "Connected apps", "Always allowed"], keywords: "folder directory path mcp tools apps composio gmail slack grants library" },
      { id: "model", label: "Model", icon: "Sparkles", rows: ["Host", "Agent profile", "Provider", "Model", "Thinking"], keywords: "effort reasoning" },
      { id: "permissions", label: "Permissions", icon: "Shield", rows: ["Mode"], keywords: "approval permissions ask auto" },
    ],
  },
  {
    label: "Activity",
    sections: [
      { id: "history", label: "History", icon: "History", rows: ["Earlier versions"], keywords: "undo restore changes" },
      { id: "usage", label: "Usage", icon: "ChartNoAxesColumn", rows: ["Chats", "Tokens", "Cost"], keywords: "usage" },
    ],
  },
];

const SECTIONS = GROUPS.flatMap((group) => group.sections);

export interface PanelProps {
  colors: Colors;
  bot: Bot;
  localHost: LocalHost;
  history: HistoryEntry[];
  /** The shared skills and MCP servers the bot picks from. */
  library: Library;
  onPatch(patch: Partial<Bot>): void;
  /** Saves pending edits now (routines run from the saved bot). */
  flush(): Promise<void>;
  onRestore(snapshot: Bot): void;
  onSetup(): void;
}

interface BotPanelProps extends PanelProps {
  /** Open section (detail view), or null for the section list. */
  section: SectionId | null;
  onSection(section: SectionId | null): void;
  onClose(): void;
  /** The surface's compact layout; falls back to the window width. */
  compact?: boolean;
}

/**
 * Bot settings as Paseo's list+detail (docs/design.md §9) in its compact form: a
 * section list, and a pushed detail page whose header carries a back arrow.
 */
export function BotPanel(props: BotPanelProps) {
  const { colors, bot, localHost, section, onSection, onClose } = props;
  const compact = useCompact(props.compact);
  const [query, setQuery] = useState("");
  const host = useBotHost(bot.hostId, localHost);
  const problems = botProblems(bot, host.isLocal);
  const open = section ? SECTIONS.find((entry) => entry.id === section) : undefined;

  if (open) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <PanelHeader colors={colors} compact={compact} title={open.label} onBack={() => onSection(null)} onClose={onClose} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingTop: 24, paddingBottom: 32 }}>
          {renderSection(open.id, props)}
        </ScrollView>
      </View>
    );
  }

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? SECTIONS.flatMap((entry) => {
        const rows = entry.rows.filter((row) => row.toLowerCase().includes(needle));
        const hit = rows.length > 0 || `${entry.label} ${entry.keywords}`.toLowerCase().includes(needle);
        return hit ? [{ entry, rows }] : [];
      })
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <PanelHeader colors={colors} compact={compact} title={bot.name || "Untitled bot"} onClose={onClose} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ paddingHorizontal: 8, paddingTop: 8, gap: 8 }}>
          <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search settings" />
          {problems.length > 0 ? <Alert colors={colors} variant="warning" title="Needs attention" description={problems} /> : null}
        </View>
        {needle ? (
          <View style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
            {matches.map(({ entry, rows }) => (
              <SectionRow key={entry.id} colors={colors} compact={compact} entry={entry} hint={rows.join(", ")} onPress={() => onSection(entry.id)} />
            ))}
            {matches.length === 0 ? (
              <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, textAlign: "center", paddingVertical: 32 }}>No settings match "{query.trim()}"</Text>
            ) : null}
          </View>
        ) : (
          GROUPS.map((group) => (
            <View key={group.label} style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
              <Text style={{ fontSize: ui(14), color: nativeTokens(colors).foregroundExtraMuted, paddingHorizontal: 8, paddingVertical: 4 }}>{group.label}</Text>
              {group.sections.map((entry) => (
                <SectionRow key={entry.id} colors={colors} compact={compact} entry={entry} onPress={() => onSection(entry.id)} />
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function renderSection(id: SectionId, props: PanelProps): ReactNode {
  switch (id) {
    case "overview":
      return <OverviewSection {...props} />;
    case "identity":
      return <IdentitySection {...props} />;
    case "soul":
      return <SoulSection {...props} />;
    case "skills":
      return <SkillsSection {...props} />;
    case "memory":
      return <MemorySection {...props} />;
    case "routines":
      return <RoutinesSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "model":
      return <ModelSection {...props} />;
    case "permissions":
      return <PermissionsSection {...props} />;
    case "history":
      return <HistorySection {...props} />;
    case "usage":
      return <UsageSection {...props} />;
  }
}

/**
 * Paseo's settings sidebar item (settings-screen.tsx sidebarStyles.item: 28 min height, 4/8
 * padding, radius 8, 16pt icon, muted 14pt label, surfaceSidebarHover on hover) with a
 * drill-in chevron, since the detail replaces the list here. Touch-sized (36) on compact.
 */
function SectionRow({ colors, compact, entry, hint, onPress }: { colors: Colors; compact: boolean; entry: SectionEntry; hint?: string; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 36 : 28,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: hovered || pressed ? colors.surface1 : "transparent",
      })}
    >
      <Icon name={entry.icon} size={16} color={hovered ? colors.foreground : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), color: hovered ? colors.foreground : colors.foregroundMuted }}>
          {entry.label}
        </Text>
        {hint ? (
          <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
    </Pressable>
  );
}

/**
 * One header row: the bot name on the list, a back arrow and the section title on a
 * detail page (BackHeader), and the close button. 36 high on desktop, 48 on compact;
 * the title is ScreenTitle (14pt, weight 300 desktop / 400 compact).
 */
function PanelHeader({ colors, compact, title, onBack, onClose }: { colors: Colors; compact: boolean; title: string; onBack?: () => void; onClose(): void }) {
  return (
    <View
      style={{
        height: compact ? 56 : 36,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: onBack ? 4 : compact ? 16 : 12,
        paddingRight: compact ? 8 : 4,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      {onBack ? <HeaderButton colors={colors} compact={compact} icon="ArrowLeft" label="Back to bot settings" iconSize={20} onPress={onBack} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), fontWeight: compact ? "400" : "300", color: colors.foreground }}>
        {title}
      </Text>
      <HeaderButton colors={colors} compact={compact} icon="X" label="Close bot settings" iconSize={18} onPress={onClose} />
    </View>
  );
}

/** Header control: 34 box on desktop, 32 on compact; interactionHighlight on hover and press. */
function HeaderButton({ colors, compact, icon, label, iconSize, onPress }: { colors: Colors; compact: boolean; icon: string; label: string; iconSize: number; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  const box = compact ? 32 : 34;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        width: box,
        height: box,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? nativeTokens(colors).interactionHighlight : "transparent",
      })}
    >
      <Icon name={icon} size={iconSize} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}
