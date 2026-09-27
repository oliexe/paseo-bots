import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type LayoutRectangle } from "react-native";
import type { toWire } from "../shared/attachments";
import type { Bot } from "../shared/bot";
import { displayTitle } from "../shared/chat";
import { Avatar } from "./Avatar";
import { Composer } from "./chat/Composer";
import { ChatStream } from "./chat/Stream";
import type { BotHost } from "./data";
import { nativeTokens, useHover } from "./native";
import { ui } from "./typography";
import { measureAnchor } from "./ui/Menu";
import { listenForFind } from "./web";
import type { ChatState } from "./useChat";

type Colors = PluginTheme["colors"];

export interface ChatPaneProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  chat: ChatState;
  chatId: string | null;
  panelOpen: boolean;
  layout: { compact: boolean; platform: "ios" | "android" | "web" };
  keyboardOpen: boolean;
  /** Bumps when Paseo's font sizes change, so list rows re-render. */
  typeVersion: number;
  onBack?(): void;
  /** Opens the bot menu anchored to the header's "···" button. */
  onBotMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  /** Creates the chat with its first message. */
  onStart(message: OutgoingMessage): Promise<void>;
  /** Shows another chat of this bot (a routine run's own chat). */
  onOpenChat(chatId: string): void;
}

export interface OutgoingMessage {
  text: string;
  messageId: string;
  images: { data: string; mimeType: string }[];
  attachments: ReturnType<typeof toWire>["attachments"];
}

export function ChatPane({ colors, bot, host, chat, chatId, panelOpen, layout, keyboardOpen, typeVersion, onBack, onBotMenu, onTogglePanel, onStart, onOpenChat }: ChatPaneProps) {
  const running = chat.agent?.status === "running" || chat.agent?.status === "initializing";
  const empty = chat.entries.length === 0 && !chat.loading && !chat.error && (chat.agent?.pendingPermissions.length ?? 0) === 0;
  const title = chatId ? displayTitle(chat.agent?.title) : "New chat";
  const canFind = chatId !== null && !empty;
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => setFindOpen(false), [chatId]);
  // ⌘F / Ctrl+F finds in the open chat on the desktop.
  useEffect(() => (canFind ? listenForFind(() => setFindOpen(true)) : undefined), [canFind]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <Header
        colors={colors}
        title={title}
        subtitle={bot.name}
        hostBadge={host.isLocal ? null : host.label}
        compact={layout.compact}
        panelOpen={panelOpen}
        onBack={onBack}
        onMenu={onBotMenu}
        onTogglePanel={onTogglePanel}
        onFind={canFind ? () => setFindOpen((open) => !open) : undefined}
      />
      {chatId === null || empty ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
          <Avatar avatar={bot.avatar} size={56} />
          <Text style={{ color: colors.foreground, fontSize: ui(18), fontWeight: "500" }}>{bot.name}</Text>
          {bot.description ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), textAlign: "center", maxWidth: 420 }}>{bot.description}</Text>
          ) : null}
        </View>
      ) : (
        <ChatStream key={chatId} colors={colors} chat={chat} api={host.api} agentId={chatId} compact={layout.compact} platform={layout.platform} typeVersion={typeVersion} onOpenChat={onOpenChat} voice={bot.voice} findOpen={findOpen} onCloseFind={() => setFindOpen(false)} {...(host.isLocal ? { botId: bot.id } : {})} />
      )}
      <Composer colors={colors} bot={bot} host={host} agentId={chatId} agent={chat.agent} running={running} layout={layout} keyboardOpen={keyboardOpen} onStart={onStart} />
    </View>
  );
}

// ---------------------------------------------------------------- header

interface HeaderProps {
  colors: Colors;
  title: string;
  subtitle: string;
  /** Host label when the bot runs on another host (Paseo shows it as a badge in the subtitle). */
  hostBadge: string | null;
  compact: boolean;
  panelOpen: boolean;
  onBack?(): void;
  onMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  /** Opens or closes find in chat; absent while there's nothing to find. */
  onFind?: () => void;
}

// Paseo's workspace header (components/headers/screen-header.tsx, workspace-screen.tsx):
// 36 high on desktop with the title (weight 300) and project name inline; 56 on phones
// with the title (weight 400) over a 12pt subtitle row. Icon buttons are 26 (desktop) or
// 32 (phones) with 16pt glyphs; the back arrow is Paseo's BackHeader (ArrowLeft 20, 44pt box).
function Header({ colors, title, subtitle, hostBadge, compact, panelOpen, onBack, onMenu, onTogglePanel, onFind }: HeaderProps) {
  const tokens = nativeTokens(colors);
  const menuButton = useRef<View>(null);
  const openMenu = () => void measureAnchor(menuButton).then(onMenu);
  const separator = <Text style={{ fontSize: ui(12), color: tokens.foregroundExtraMuted }}> · </Text>;
  return (
    <View style={{ height: compact ? 56 : 36, flexDirection: "row", alignItems: "center", gap: compact ? 4 : 8, paddingHorizontal: compact ? 4 : 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface0 }}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to bots"
          onPress={onBack}
          style={({ pressed }) => ({ padding: compact ? 12 : 8, borderRadius: 8, backgroundColor: pressed ? tokens.interactionHighlight : "transparent" })}
        >
          <Icon name="ArrowLeft" size={20} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
      {compact ? (
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: ui(14), fontWeight: "400", color: colors.foreground }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
            {subtitle}
            {hostBadge ? separator : null}
            {hostBadge}
          </Text>
        </View>
      ) : (
        <>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), fontWeight: "300", color: colors.foreground }}>
            {title}
          </Text>
          {subtitle !== title ? (
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), color: colors.foregroundMuted }}>
              {subtitle}
              {hostBadge ? ` · ${hostBadge}` : ""}
            </Text>
          ) : null}
        </>
      )}
      {compact ? null : (
        <View ref={menuButton} collapsable={false}>
          <HeaderButton colors={colors} compact={false} icon="Ellipsis" label="Bot actions" onPress={openMenu} />
        </View>
      )}
      <View style={{ flex: 1 }} />
      {compact ? (
        <View ref={menuButton} collapsable={false}>
          <HeaderButton colors={colors} compact icon="Ellipsis" label="Bot actions" onPress={openMenu} />
        </View>
      ) : null}
      {onFind ? <HeaderButton colors={colors} compact={compact} icon="Search" label="Find in chat" onPress={onFind} /> : null}
      {/* On desktop the open panel owns its close button, so the toggle hides (workspace-explorer-toggle.tsx). */}
      {compact || !panelOpen ? (
        <HeaderButton colors={colors} compact={compact} icon="PanelRight" label="Show bot settings" expanded={panelOpen} onPress={onTogglePanel} />
      ) : null}
    </View>
  );
}

function HeaderButton({ colors, compact, icon, label, expanded, onPress }: { colors: Colors; compact: boolean; icon: string; label: string; expanded?: boolean; onPress(): void }) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  const size = compact ? 32 : 26;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? tokens.interactionHighlight : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={compact ? colors.foregroundMuted : tokens.foregroundExtraMuted} />
    </Pressable>
  );
}
