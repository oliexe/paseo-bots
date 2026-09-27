import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutRectangle } from "react-native";
import type { Library } from "../../shared/bot";
import { matchesQuery, mcpTarget } from "../../shared/library";
import type { LibraryTarget } from "../navigation";
import { nativeTokens, useHover } from "../native";
import { SearchField } from "../panel/controls";
import { connectedApps, useAppsAccounts, useAppsCatalog, useAppsStatus } from "./apps";
import { AppLogo } from "./parts";
import { ui } from "../typography";
import { measureAnchor } from "../ui/Menu";

type Colors = PluginTheme["colors"];

interface LibraryListProps {
  colors: Colors;
  library: Library;
  query: string;
  onQuery(query: string): void;
  /** Highlighted row; null on compact, where the list is its own screen. */
  selected: LibraryTarget | null;
  onSelect(target: LibraryTarget): void;
  onAddSkill(anchor: LayoutRectangle): void;
  onAddServer(anchor: LayoutRectangle): void;
  /** Taller rows for touch. */
  touch: boolean;
  /** Desktop: a "Back to bots" row heads the column, like settings' "Back to workspace". */
  onBack?(): void;
  /** The home indicator on phones. */
  bottomInset: number;
}

/**
 * The page's list column, in the settings sidebar's geometry (settings-screen.tsx):
 * a group per kind with its items and an add button.
 */
export function LibraryList({ colors, library, query, onQuery, selected, onSelect, onAddSkill, onAddServer, touch, onBack, bottomInset }: LibraryListProps) {
  const skills = library.skills
    .filter((skill) => matchesQuery(query, skill.id, skill.description, skill.source))
    .sort((a, b) => a.id.localeCompare(b.id));
  const servers = library.mcpServers
    .filter((server) => matchesQuery(query, server.name, server.description, mcpTarget(server.config)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const searching = query.trim().length > 0;
  const is = (kind: LibraryTarget["kind"], id?: string) => selected?.kind === kind && (id === undefined || ("id" in selected && selected.id === id));
  const appsStatus = useAppsStatus();
  const configured = appsStatus.data?.configured ?? false;
  const accounts = useAppsAccounts(configured);
  const catalog = useAppsCatalog(configured);
  const apps = connectedApps(accounts.data?.accounts ?? [], catalog.data?.apps ?? []).filter((app) => matchesQuery(query, app.name, app.slug));

  return (
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 + bottomInset }}>
      {/* Paseo's sidebar header group: its rows over a full-width divider (left-sidebar.tsx sidebarHeaderGroup). */}
      <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8, gap: 2, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {onBack ? <NavRow colors={colors} icon="ArrowLeft" label="Back to bots" selected={false} touch={touch} onPress={onBack} /> : null}
        <SearchField colors={colors} value={query} onChangeText={onQuery} placeholder="Search skills and tools" />
      </View>

      <Group colors={colors} label="Skills" addLabel="Add skill" onAdd={onAddSkill}>
        {skills.map((skill) => (
          <NavRow
            key={skill.id}
            colors={colors}
            icon="Puzzle"
            label={skill.id}
            note={skill.reviewedSha === null ? "Review" : skill.enabled ? undefined : "Off"}
            selected={is("skill", skill.id)}
            touch={touch}
            onPress={() => onSelect({ kind: "skill", id: skill.id })}
          />
        ))}
        {skills.length === 0 ? <GroupNote colors={colors} text={searching ? "No matching skills" : "No skills yet"} /> : null}
      </Group>
      <Divider colors={colors} />

      <Group colors={colors} label="MCP servers" addLabel="Add MCP server" onAdd={onAddServer}>
        {servers.map((server) => (
          <NavRow
            key={server.id}
            colors={colors}
            icon="Plug"
            label={server.name}
            note={server.enabled ? undefined : "Off"}
            selected={is("mcp", server.id)}
            touch={touch}
            onPress={() => onSelect({ kind: "mcp", id: server.id })}
          />
        ))}
        {servers.length === 0 ? <GroupNote colors={colors} text={searching ? "No matching servers" : "No MCP servers yet"} /> : null}
      </Group>
      <Divider colors={colors} />

      <Group colors={colors} label="Connected apps" addLabel={configured ? "Connect an app" : "Set up connected apps"} onAdd={() => onSelect({ kind: "apps" })}>
        {apps.map((app) => (
          <NavRow
            key={app.slug}
            colors={colors}
            icon="AppWindow"
            leading={<AppLogo colors={colors} app={app} size={16} />}
            label={app.name}
            note={app.status === "connected" ? undefined : app.status === "pending" ? "Pending" : "Failed"}
            selected={is("app", app.slug)}
            touch={touch}
            onPress={() => onSelect({ kind: "app", id: app.slug })}
          />
        ))}
        {apps.length === 0 ? <GroupNote colors={colors} text={searching ? "No matching apps" : configured ? "No apps connected yet" : "Not set up yet"} /> : null}
      </Group>
    </ScrollView>
  );
}

/** A nav group: extra-muted 14pt label (8/4 padding) with its count and a trailing add button. */
function Group({ colors, label, addLabel, onAdd, children }: { colors: Colors; label: string; addLabel: string; onAdd(anchor: LayoutRectangle): void; children: ReactNode }) {
  const tokens = nativeTokens(colors);
  return (
    <View style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 4, minHeight: 28 }}>
        <Text style={{ flex: 1, fontSize: ui(14), color: tokens.foregroundExtraMuted }}>{label}</Text>
        <AddButton colors={colors} label={addLabel} onPress={onAdd} />
      </View>
      {children}
    </View>
  );
}

/** The full-width line Paseo's sidebar draws between its sections. */
function Divider({ colors }: { colors: Colors }) {
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

function GroupNote({ colors, text }: { colors: Colors; text: string }) {
  return <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, paddingHorizontal: 8, paddingVertical: 4 }}>{text}</Text>;
}

/** Ghost icon button like the sidebar's section actions: 24 box, radius 6, Plus 14. */
function AddButton({ colors, label, onPress }: { colors: Colors; label: string; onPress(anchor: LayoutRectangle): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onPress(anchor))}
      {...hoverProps}
      style={({ pressed }) => ({ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: hovered || pressed ? colors.surface1 : "transparent" })}
    >
      <Icon name="Plus" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

interface NavRowProps {
  colors: Colors;
  icon: string;
  label: string;
  /** Replaces the icon, e.g. an app's logo. */
  leading?: ReactNode;
  /** A short muted note on the right ("Off", "Pending"); the label is muted too. */
  note?: string;
  selected: boolean;
  touch: boolean;
  onPress(): void;
}

/** Settings nav item: 28 min height (36 for touch), 4/8 padding, radius 8, 16pt icon, surfaceSidebarHover when hovered or selected. */
function NavRow({ colors, icon, leading, label, note, selected, touch, onPress }: NavRowProps) {
  const { hovered, hoverProps } = useHover();
  const strong = selected || hovered;
  const tint = strong ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note ? `${label}, ${note}` : label}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: touch ? 36 : 28,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: strong || pressed ? colors.surface1 : "transparent",
      })}
    >
      {leading ?? <Icon name={icon} size={16} color={tint} />}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), color: tint, opacity: note ? 0.6 : 1 }}>
        {label}
      </Text>
      {note ? <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{note}</Text> : null}
    </Pressable>
  );
}
