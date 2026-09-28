import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent } from "@getpaseo/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Animated, Easing, Platform, Pressable, Text, View, type LayoutRectangle } from "react-native";
import type { Bot, BotGroup, BotListUi } from "../shared/bot";
import { displayTitle } from "../shared/chat";
import type { TeamTab } from "../shared/groups";
import { aggregateBuckets, BUCKET_LABELS, chatBucket, orderChats, SIDEBAR_GROUP_LIMIT, type ChatBucket } from "../shared/sidebar";
import { Avatar } from "./Avatar";
import { useBotChats, useBotHost, type LocalHost } from "./data";
import { openLibrary } from "./navigation";
import { nativeTokens, useHover, type NativeTokens } from "./native";
import { Splash } from "./Splash";
import { ui } from "./typography";
import { contextMenuProps, measureAnchor } from "./ui/Menu";
import { tooltip } from "./ui/Tooltip";

// Paseo's sidebar, reproduced from components/left-sidebar.tsx, sidebar-workspace-list.tsx
// and components/sidebar/*: bot rows are project rows, chat rows are workspace rows.

type Colors = PluginTheme["colors"];

export interface Selection {
  botId: string;
  /** Null is a new, not yet started chat. */
  chatId: string | null;
  /** First message to send straight away when starting a new chat. */
  prompt?: string;
}

export type MenuSource = "kebab" | "context";

export interface ChatMenuContext {
  /** Every unpinned chat of the bot in list order, for Move up / Move down. */
  siblings: string[];
  pinned: boolean;
}

interface BotSidebarProps {
  colors: Colors;
  bots: readonly Bot[];
  /** With teams, the open team tab: the list shows its bots. */
  openTab: TeamTab | null;
  /** Archived bots hidden by the display preferences. Keeps the header (and its menu) up when they're all that's left. */
  hiddenArchivedCount: number;
  selection: Selection | null;
  ui: BotListUi;
  localHost: LocalHost;
  /** Touch devices have no hover: row actions stay visible. */
  touch: boolean;
  /** Phone layout: with no bots at all, show the Paseo Bots splash instead of the empty state. */
  splash?: boolean;
  /** The home indicator: Paseo's mobile sidebar pads its panel by the bottom safe area. */
  bottomInset: number;
  onToggle(botId: string): void;
  onTogglePinnedSection(): void;
  onShowArchived(): void;
  onSelect(selection: Selection): void;
  onNewBot(): void;
  onBotMenu(bot: Bot, anchor: LayoutRectangle, source: MenuSource): void;
  onChatMenu(bot: Bot, chat: PaseoAgent, anchor: LayoutRectangle, source: MenuSource, context: ChatMenuContext): void;
  onDisplayMenu(anchor: LayoutRectangle): void;
  onEditTeam(group: BotGroup): void;
  onTeamMap(): void;
}

const noSelect = { userSelect: "none" } as object;
/** Paseo hardcodes the project chevron colour (project-leading-visual.tsx). */
const CHEVRON_COLOR = "#9ca3af";

export function BotSidebar(props: BotSidebarProps) {
  const { colors, bots, openTab, ui: listUi, hiddenArchivedCount, bottomInset, onNewBot, onShowArchived, onTeamMap, onEditTeam } = props;
  const tokens = nativeTokens(colors);
  const shown = openTab?.bots ?? bots;
  const pinnedIds = new Set(listUi.pinnedChats.map((pin) => pin.chatId));
  const listedBots = new Map(shown.map((bot) => [bot.id, bot]));
  const pins = listUi.pinnedChats.filter((pin) => listedBots.has(pin.botId));
  const leadId = openTab?.group?.leadId ?? null;
  if (props.splash && bots.length === 0 && hiddenArchivedCount === 0 && pins.length === 0 && !openTab) {
    return (
      <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
        <Splash colors={colors} background={tokens.surfaceSidebar} />
        <Footer colors={colors} onNewBot={onNewBot} onTeamMap={onTeamMap} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 }}
      >
        {pins.length > 0 ? <PinnedSection {...props} pins={pins} botById={listedBots} tokens={tokens} /> : null}
        {shown.length > 0 || hiddenArchivedCount > 0 ? <SectionHeader colors={colors} onDisplayMenu={props.onDisplayMenu} /> : null}
        {shown.map((bot) => (
          <BotGroup key={bot.id} {...props} tokens={tokens} bot={bot} lead={bot.id === leadId} pinnedIds={pinnedIds} />
        ))}
        {openTab?.group && shown.length === 0 ? (
          <EmptyState colors={colors} title="No bots on this team" description="Add bots to it in the team's settings." action={{ icon: "Pencil", label: "Edit team", onPress: () => onEditTeam(openTab.group!) }} />
        ) : bots.length === 0 ? (
          hiddenArchivedCount > 0 ? (
            <EmptyState
              colors={colors}
              title="All bots are archived"
              description="Show archived bots to see them here."
              action={{ icon: "Archive", label: "Show archived", onPress: onShowArchived }}
            />
          ) : (
            <EmptyState colors={colors} title="No bots yet" description="Create a bot to get started" action={{ icon: "Plus", label: "New bot", onPress: onNewBot }} />
          )
        ) : null}
      </ScrollView>
      <Footer colors={colors} onNewBot={onNewBot} onTeamMap={onTeamMap} />
    </View>
  );
}

// ------------------------------------------------------------------ header / footer / empty

function SectionHeader({ colors, onDisplayMenu }: { colors: Colors; onDisplayMenu(anchor: LayoutRectangle): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingLeft: 8, paddingRight: 4, paddingTop: 4, paddingBottom: 4 }}>
      <Text style={[{ fontSize: ui(12), color: colors.foregroundMuted }, noSelect]}>Bots</Text>
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel="Display preferences"
        {...tooltip("Display preferences", "bottom")}
        onPress={() => void measureAnchor(ref).then((anchor) => anchor && onDisplayMenu(anchor))}
        {...hoverProps}
        style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: hovered ? colors.surface1 : "transparent" }}
      >
        <Icon name="Settings2" size={14} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function Footer({ colors, onNewBot, onTeamMap }: { colors: Colors; onNewBot(): void; onTeamMap(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New bot"
        onPress={onNewBot}
        {...hoverProps}
        style={({ pressed }) => [
          {
            minWidth: 0,
            minHeight: 32,
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 6,
            paddingHorizontal: 8,
            borderRadius: 8,
            backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent",
          },
          noSelect,
        ]}
      >
        <Icon name="Plus" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, fontSize: ui(14), color: hovered ? colors.foreground : colors.foregroundMuted }}>
          New bot
        </Text>
      </Pressable>
      <FooterIconButton colors={colors} icon="Network" label="Team map" onPress={onTeamMap} />
      <FooterIconButton colors={colors} icon="Blocks" label="Skills & Tools" onPress={() => openLibrary()} />
    </View>
  );
}

/** The sidebar footer's trailing icon buttons (Paseo's host, import and settings buttons): 32 box, 16pt icon. */
function FooterIconButton({ colors, icon, label, onPress }: { colors: Colors; icon: string; label: string; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label)}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent" },
        noSelect,
      ]}
    >
      <Icon name={icon} size={16} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

/** Paseo's SidebarProjectEmptyState (sidebar/empty-states.tsx). */
function EmptyState({ colors, title, description, action }: { colors: Colors; title: string; description: string; action: { icon: string; label: string; onPress(): void } }) {
  return (
    <View style={{ marginHorizontal: 8, marginTop: 16, paddingTop: 24, paddingBottom: 16, paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.surface0, alignItems: "center", gap: 12 }}>
      <Text style={{ color: colors.foreground, fontSize: ui(12), fontWeight: "500", textAlign: "center" }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(12), textAlign: "center" }}>{description}</Text>
      <GhostButton colors={colors} icon={action.icon} label={action.label} onPress={action.onPress} />
    </View>
  );
}

/** Paseo's Button variant="ghost" size="sm". */
function GhostButton({ colors, icon, label, onPress }: { colors: Colors; icon: string; label: string; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  const tint = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "transparent",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={14} color={tint} />
      <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------ pinned

type PinnedProps = BotSidebarProps & { pins: BotListUi["pinnedChats"]; botById: ReadonlyMap<string, Bot>; tokens: NativeTokens };

function PinnedSection(props: PinnedProps) {
  const { colors, pins, ui: listUi, touch, onTogglePinnedSection } = props;
  const collapsed = listUi.pinnedCollapsed;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? pins : pins.slice(0, SIDEBAR_GROUP_LIMIT);
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ marginBottom: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Pinned"
        accessibilityState={{ expanded: !collapsed }}
        onPress={onTogglePinnedSection}
        {...hoverProps}
        style={[{ minHeight: 36, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4, paddingHorizontal: 8, paddingVertical: 4 }, noSelect]}
      >
        <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>Pinned</Text>
        {hovered || touch ? <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={12} color={colors.foregroundMuted} /> : null}
      </Pressable>
      {collapsed ? null : (
        <>
          {visible.map((pin) => (
            <PinnedChatRow key={pin.chatId} {...props} bot={props.botById.get(pin.botId)!} chatId={pin.chatId} />
          ))}
          {pins.length > SIDEBAR_GROUP_LIMIT ? <ShowMoreRow colors={colors} expanded={expanded} onPress={() => setExpanded(!expanded)} /> : null}
        </>
      )}
    </View>
  );
}

function PinnedChatRow({ colors, tokens, bot, chatId, selection, localHost, touch, onSelect, onChatMenu }: PinnedProps & { bot: Bot; chatId: string }) {
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const chat = chats.data?.find((entry) => entry.id === chatId);
  if (!chat) return null;
  return (
    <ChatRow
      colors={colors}
      tokens={tokens}
      chat={chat}
      bot={bot}
      hoisted
      touch={touch}
      selected={selection?.botId === bot.id && selection.chatId === chat.id}
      onPress={() => onSelect({ botId: bot.id, chatId: chat.id })}
      onMenu={(anchor, source) => onChatMenu(bot, chat, anchor, source, { siblings: [], pinned: true })}
    />
  );
}

// ------------------------------------------------------------------ bot group

type GroupProps = BotSidebarProps & { bot: Bot; tokens: NativeTokens; pinnedIds: ReadonlySet<string>; /** The team's Chief of Staff. */ lead?: boolean };

function BotGroup(props: GroupProps) {
  const { colors, tokens, bot, selection, ui: listUi, localHost, touch, pinnedIds, onSelect, onChatMenu } = props;
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const [expanded, setExpanded] = useState(false);
  const isOpen = !listUi.collapsed.includes(bot.id);
  const botSelected = selection?.botId === bot.id;
  const draftSelected = botSelected && selection?.chatId === null;

  const unpinned = (chats.data ?? []).filter((chat) => !pinnedIds.has(chat.id));
  const ordered = orderChats(unpinned, listUi.chatSort, listUi.chatOrder[bot.id]);
  const siblings = ordered.map((chat) => chat.id);
  const visible = expanded ? ordered : ordered.slice(0, SIDEBAR_GROUP_LIMIT);
  const loading = !!host.api && chats.isLoading;
  // Collapsed rows carry their chats' most urgent status; open ones leave it to the rows.
  const aggregate = isOpen ? null : aggregateBuckets(unpinned.map(chatBucket));

  let children: ReactNode = null;
  if (isOpen) {
    if (loading) children = <SkeletonRows colors={colors} />;
    else if (ordered.length > 0 || draftSelected) {
      children = (
        <>
          {draftSelected && ordered.length > 0 ? <NewChatGhostRow colors={colors} tokens={tokens} selected onPress={() => onSelect({ botId: bot.id, chatId: null })} /> : null}
          {visible.map((chat) => (
            <ChatRow
              key={chat.id}
              colors={colors}
              tokens={tokens}
              chat={chat}
              bot={bot}
              touch={touch}
              selected={botSelected && selection?.chatId === chat.id}
              onPress={() => onSelect({ botId: bot.id, chatId: chat.id })}
              onMenu={(anchor, source) => onChatMenu(bot, chat, anchor, source, { siblings, pinned: false })}
            />
          ))}
          {ordered.length > SIDEBAR_GROUP_LIMIT ? <ShowMoreRow colors={colors} expanded={expanded} onPress={() => setExpanded(!expanded)} /> : null}
          {ordered.length === 0 ? <NewChatGhostRow colors={colors} tokens={tokens} selected onPress={() => onSelect({ botId: bot.id, chatId: null })} /> : null}
        </>
      );
    } else if (host.api) {
      children = <NewChatGhostRow colors={colors} tokens={tokens} selected={false} onPress={() => onSelect({ botId: bot.id, chatId: null })} />;
    }
  }

  return (
    <View role="group" accessibilityLabel={bot.name} style={{ paddingBottom: children ? 12 : 0 }}>
      <BotRow {...props} isOpen={isOpen} aggregate={aggregate} hostLabel={host.online ? null : host.label} />
      {children}
    </View>
  );
}

function BotRow({ colors, tokens, bot, lead, touch, isOpen, aggregate, hostLabel, onToggle, onSelect, onBotMenu }: GroupProps & { isOpen: boolean; aggregate: ChatBucket | null; hostLabel: string | null }) {
  const [hovered, setHovered] = useState(false);
  const kebabRef = useRef<View>(null);
  const plus = useHover();
  const actionsVisible = hovered || touch;
  const backdrop = hovered ? colors.surface1 : tokens.surfaceSidebar;
  // The row's press target sits behind its content and the + / ⋮ buttons are its siblings,
  // not children: nested pressables let a button press leak into the row on react-native-web.
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        {
          position: "relative",
          minHeight: 36,
          paddingVertical: 8,
          paddingHorizontal: 8,
          borderRadius: 8,
          marginBottom: 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          backgroundColor: hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={bot.name}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => onToggle(bot.id)}
        {...contextMenuProps((anchor) => onBotMenu(bot, anchor, "context"))}
        style={({ pressed }) => ({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 8, backgroundColor: pressed ? colors.surface2 : "transparent" })}
      />
      <View pointerEvents="none" style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <View style={{ width: 16, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
          {hovered ? (
            <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={14} color={CHEVRON_COLOR} />
          ) : (
            <View style={{ position: "relative", width: 16, height: 16 }}>
              <Avatar avatar={bot.avatar} size={16} />
              {aggregate ? <StatusBadge colors={colors} tokens={tokens} bucket={aggregate} backdrop={backdrop} /> : null}
            </View>
          )}
        </View>
        <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, fontSize: ui(14), color: colors.foregroundMuted, opacity: bot.archived ? 0.6 : 1 }}>
          {bot.name}
          {hostLabel ? ` · ${hostLabel} offline` : ""}
        </Text>
        {lead ? <Icon name="Crown" size={12} color={colors.foregroundMuted} /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0, marginRight: -6 }}>
        <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", flexShrink: 0, opacity: actionsVisible ? 1 : 0 }} pointerEvents={actionsVisible ? "auto" : "none"}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`New chat with ${bot.name}`}
            {...tooltip("New chat", "bottom")}
            hitSlop={8}
            onPress={() => onSelect({ botId: bot.id, chatId: null })}
            {...plus.hoverProps}
            style={({ pressed: down }) => ({
              width: 24,
              height: 24,
              borderRadius: 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: plus.hovered || down ? colors.surface1 : "transparent",
            })}
          >
            {({ pressed: down }) => <Icon name="Plus" size={15} color={plus.hovered || down ? colors.foreground : colors.foregroundMuted} />}
          </Pressable>
        </View>
        <View style={{ opacity: actionsVisible ? 1 : 0 }} pointerEvents={actionsVisible ? "auto" : "none"}>
          <KebabButton
            colors={colors}
            buttonRef={kebabRef}
            label="Bot actions"
            box
            onPress={() => void measureAnchor(kebabRef).then((anchor) => anchor && onBotMenu(bot, anchor, "kebab"))}
          />
        </View>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ rows

interface ChatRowProps {
  colors: Colors;
  tokens: NativeTokens;
  chat: PaseoAgent;
  bot: Bot;
  selected: boolean;
  touch: boolean;
  /** Pinned rows sit outside their bot, so they lead with its avatar and name it underneath. */
  hoisted?: boolean;
  onPress(): void;
  onMenu(anchor: LayoutRectangle, source: MenuSource): void;
}

/** Paseo's workspace row (sidebar-workspace-list.tsx workspaceRow + sidebar-workspace-row-content.tsx). */
const ChatRow = memo(function ChatRow({ colors, tokens, chat, bot, selected, touch, hoisted, onPress, onMenu }: ChatRowProps) {
  const [hovered, setHovered] = useState(false);
  const kebabRef = useRef<View>(null);
  const bucket = chatBucket(chat);
  const title = displayTitle(chat.title);
  const showKebab = hovered || touch;
  const background = selected ? tokens.surfaceSidebarSelected : hovered ? colors.surface1 : "transparent";
  // As in BotRow: the press target sits behind the content and the ⋮ is its sibling, so a
  // kebab press can't also select the chat.
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        {
          position: "relative",
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 8,
          paddingRight: 12,
          borderRadius: 8,
          justifyContent: "center",
          backgroundColor: background,
        },
        noSelect,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${BUCKET_LABELS[bucket]}`}
        accessibilityState={{ selected }}
        onPress={onPress}
        {...contextMenuProps((anchor) => onMenu(anchor, "context"))}
        style={({ pressed }) => ({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 8, backgroundColor: pressed ? colors.surface2 : "transparent" })}
      />
      <View pointerEvents="none" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, width: "100%" }}>
        {hoisted ? (
          <View style={{ width: 16, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "relative", width: 16, height: 16 }}>
              <Avatar avatar={bot.avatar} size={16} />
              {bucket !== "done" ? <StatusBadge colors={colors} tokens={tokens} bucket={bucket} backdrop={selected ? tokens.surfaceSidebarSelected : hovered ? colors.surface1 : tokens.surfaceSidebar} /> : null}
            </View>
          </View>
        ) : (
          <ChatStatusSlot colors={colors} tokens={tokens} bucket={bucket} />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), fontWeight: "400", lineHeight: 20, color: colors.foreground, opacity: hovered ? 1 : 0.76 }}>
              {title}
            </Text>
            {/* On touch the kebab stays, so its space is reserved; on desktop it overlays the title's tail. */}
            {touch ? <View style={{ width: 18, height: 20 }} /> : null}
          </View>
          {hoisted ? (
            <Text numberOfLines={1} style={{ fontSize: ui(12), lineHeight: 16, color: colors.foregroundMuted }}>
              {bot.name}
            </Text>
          ) : null}
        </View>
      </View>
      {showKebab ? (
        <View style={{ position: "absolute", top: 8, right: 12, flexDirection: "row" }}>
          {/* A short scrim in the row's colour hides the title's tail under the kebab, as native does. */}
          {touch ? null : <View pointerEvents="none" style={{ width: 16, backgroundColor: hovered ? colors.surface1 : "transparent" }} />}
          <View style={{ backgroundColor: selected ? tokens.surfaceSidebarSelected : colors.surface1 }}>
            <KebabButton colors={colors} buttonRef={kebabRef} label="Chat actions" onPress={() => void measureAnchor(kebabRef).then((anchor) => anchor && onMenu(anchor, "kebab"))} />
          </View>
        </View>
      ) : null}
    </View>
  );
});

/** Paseo's NewWorkspaceGhostRow: the one row indented 16 so it reads as belonging to its bot. */
function NewChatGhostRow({ colors, tokens, selected, onPress }: { colors: Colors; tokens: NativeTokens; selected: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New chat"
      accessibilityState={{ selected }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 16,
          paddingRight: 12,
          borderRadius: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed ? colors.surface2 : selected ? tokens.surfaceSidebarSelected : hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      {({ pressed }) => (
        <>
          <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon name="Plus" size={14} color={hovered || pressed || selected ? colors.foreground : colors.foregroundMuted} />
          </View>
          <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, fontSize: ui(14), color: hovered || pressed || selected ? colors.foreground : colors.foregroundMuted }}>
            New chat
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Paseo's SidebarGroupToggleRow. */
function ShowMoreRow({ colors, expanded, onPress }: { colors: Colors; expanded: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  const label = expanded ? "Show less" : "Show more";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 8,
          paddingRight: 12,
          borderRadius: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      {({ pressed }) => (
        <>
          <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={hovered || pressed ? colors.foreground : colors.foregroundMuted} />
          </View>
          <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, fontSize: ui(14), color: hovered || pressed ? colors.foreground : colors.foregroundMuted }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * Kebab triggers. Chat rows use Paseo's workspace trigger (padding 2, radius 4, pulled
 * onto the rail with marginRight -7); bot rows use the 24pt project kebab (`box`).
 */
function KebabButton({ colors, buttonRef, label, box, onPress }: { colors: Colors; buttonRef: RefObject<View | null>; label: string; box?: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
      hitSlop={8}
      onPress={onPress}
      {...hoverProps}
      style={
        box
          ? { width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: hovered ? colors.surface2 : "transparent" }
          : { padding: 2, borderRadius: 4, marginLeft: 2, marginRight: -7, backgroundColor: hovered ? colors.surface2 : "transparent" }
      }
    >
      <Icon name="MoreVertical" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

// ------------------------------------------------------------------ status glyphs

/** Paseo's WorkspaceStatusIndicator: one 16×20 slot every status shares. */
function ChatStatusSlot({ colors, tokens, bucket }: { colors: Colors; tokens: NativeTokens; bucket: ChatBucket }) {
  let glyph: ReactNode;
  if (bucket === "running") glyph = <StatusRing color={tokens.statusDotRunning} />;
  else if (bucket === "needs_input") glyph = <NeedsInputGlyph colors={colors} tokens={tokens} />;
  else if (bucket === "attention") glyph = <Dot color={tokens.statusDotSuccess} />;
  else if (bucket === "done") glyph = <Dot color={tokens.foregroundExtraMuted} opacity={0.3} />;
  else {
    glyph = (
      <>
        <Icon name="MessageSquare" size={14} color={colors.foregroundMuted} />
        <View style={{ position: "absolute", right: 0, bottom: 0, width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.surface0, backgroundColor: tokens.statusDotDanger }} />
      </>
    );
  }
  return (
    <View accessibilityLabel={BUCKET_LABELS[bucket]} style={{ position: "relative", width: 16, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      {glyph}
    </View>
  );
}

function Dot({ color, opacity = 1 }: { color: string; opacity?: number }) {
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity }} />;
}

/**
 * Lucide CircleAlert at 12pt with a surface0 stroke and statusDotWarning fill, as Paseo
 * draws needs-input: an amber disc with the "!" knocked out.
 */
function NeedsInputGlyph({ colors, tokens }: { colors: Colors; tokens: NativeTokens }) {
  return (
    <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 11, height: 11, borderRadius: 5.5, backgroundColor: colors.surface0, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: tokens.statusDotWarning, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 1, height: 3, borderRadius: 0.5, backgroundColor: colors.surface0 }} />
          <View style={{ width: 1, height: 1, marginTop: 1, borderRadius: 0.5, backgroundColor: colors.surface0 }} />
        </View>
      </View>
    </View>
  );
}

// Paseo's project status badge (project-leading-visual.tsx): a 12pt shell at -4 on the
// icon's bottom-right corner, filled with the row's own background so it reads as a hole.
const BADGE_SIZE = 12;
const BADGE_OFFSET = -4;
const RING_FRAME = 14;

function StatusBadge({ colors, tokens, bucket, backdrop }: { colors: Colors; tokens: NativeTokens; bucket: ChatBucket; backdrop: string }) {
  if (bucket === "done") return null;
  if (bucket === "running") {
    const offset = BADGE_OFFSET - (RING_FRAME - BADGE_SIZE) / 2;
    return (
      <View accessibilityLabel={BUCKET_LABELS[bucket]} style={{ position: "absolute", right: offset, bottom: offset }}>
        <StatusRing color={tokens.statusDotRunning} backdrop={backdrop} />
      </View>
    );
  }
  return (
    <View
      accessibilityLabel={BUCKET_LABELS[bucket]}
      style={{
        position: "absolute",
        right: BADGE_OFFSET,
        bottom: BADGE_OFFSET,
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        borderRadius: BADGE_SIZE / 2,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        backgroundColor: backdrop,
      }}
    >
      {bucket === "needs_input" ? (
        <NeedsInputGlyph colors={colors} tokens={tokens} />
      ) : (
        <Dot color={bucket === "failed" ? tokens.statusDotDanger : tokens.statusDotSuccess} />
      )}
    </View>
  );
}

// One clock for every ring (status-ring/clock.ts): every ring reads the same value, so
// rings that mount mid-turn land in phase with the ones already turning.
const RING_PERIOD_MS = 900;
const ringProgress = new Animated.Value(0);
const ringRotation = ringProgress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
let ringUsers = 0;
let ringLoop: Animated.CompositeAnimation | null = null;

function useRingClock() {
  useEffect(() => {
    ringUsers += 1;
    if (!ringLoop) {
      ringProgress.setValue(0);
      ringLoop = Animated.loop(
        Animated.timing(ringProgress, { toValue: 1, duration: RING_PERIOD_MS, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }),
      );
      ringLoop.start();
    }
    return () => {
      ringUsers -= 1;
      if (ringUsers === 0 && ringLoop) {
        ringLoop.stop();
        ringLoop = null;
      }
    };
  }, []);
  return ringRotation;
}

/**
 * Paseo's StatusRing: a 6pt dot inside a 12pt ring (1.5 stroke, track at 0.3) with a
 * quarter arc at 0.9 turning every 900ms, in a 14pt frame that knocks out `backdrop`.
 */
function StatusRing({ color, backdrop }: { color: string; backdrop?: string }) {
  const rotate = useRingClock();
  const circle = { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 } as const;
  return (
    <View style={{ width: RING_FRAME, height: RING_FRAME, borderRadius: RING_FRAME / 2, alignItems: "center", justifyContent: "center", backgroundColor: backdrop }}>
      <View style={{ ...circle, position: "absolute", borderColor: color, opacity: 0.3 }} />
      <Animated.View style={{ position: "absolute", width: 12, height: 12, transform: [{ rotate }] }}>
        <View style={{ ...circle, borderColor: "transparent", borderTopColor: color, opacity: 0.9 }} />
      </Animated.View>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

// ------------------------------------------------------------------ skeleton

/** Paseo's SidebarAgentListSkeleton rows, pulsing 0.4–0.8 over a second each way. */
function SkeletonRows({ colors }: { colors: Colors }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const native = Platform.OS !== "web";
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: native }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: native }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] });
  return (
    <View accessibilityLabel="Loading chats" style={{ gap: 4 }}>
      {[1, 0.7].map((rowOpacity) => (
        <View key={rowOpacity} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12, marginLeft: 4, opacity: rowOpacity }}>
          <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.surface2, opacity }} />
          <Animated.View style={{ flex: 1, height: 12, borderRadius: 2, backgroundColor: colors.surface2, opacity }} />
        </View>
      ))}
    </View>
  );
}
