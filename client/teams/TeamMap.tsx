import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Bot, BotGroup } from "../../shared/bot";
import { groupBots } from "../../shared/groups";
import { aggregateBuckets, chatBucket } from "../../shared/sidebar";
import { Avatar } from "../Avatar";
import { useBotChats, useBotHost, type LocalHost } from "../data";
import { CONTENT_MAX_WIDTH, nativeTokens, useHover } from "../native";
import { Button } from "../panel/controls";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

/**
 * OpenMausBot's team map: a tile per team with its Chief of Staff, an arrow,
 * and the members, each card showing what the bot is doing. Bots without a
 * team come last. Pressing a card opens the bot.
 */
export function TeamMap({
  colors,
  groups,
  bots,
  localHost,
  compact,
  onBack,
  onNewTeam,
  onEditTeam,
  onOpenBot,
}: {
  colors: Colors;
  groups: readonly BotGroup[];
  bots: readonly Bot[];
  localHost: LocalHost;
  compact: boolean;
  onBack?: () => void;
  onNewTeam(): void;
  onEditTeam(group: BotGroup): void;
  onOpenBot(bot: Bot): void;
}) {
  const tokens = nativeTokens(colors);
  const live = bots.filter((bot) => !bot.archived);
  const teamed = new Set(groups.flatMap((group) => [...group.memberIds, ...(group.leadId ? [group.leadId] : [])]));
  const loose = live.filter((bot) => !teamed.has(bot.id));
  const card = (bot: Bot, lead = false) => <BotCard key={bot.id} colors={colors} bot={bot} lead={lead} localHost={localHost} onPress={() => onOpenBot(bot)} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ height: compact ? 56 : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 4 : 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {onBack ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back to bots" onPress={onBack} style={({ pressed }) => ({ padding: 12, borderRadius: 8, backgroundColor: pressed ? tokens.interactionHighlight : "transparent" })}>
            <Icon name="ArrowLeft" size={20} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <Text style={{ fontSize: ui(14), fontWeight: "300", color: colors.foreground }}>Team map</Text>
        {compact ? null : <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>Your bots, their teams and who leads them</Text>}
        <View style={{ flex: 1 }} />
        <Button colors={colors} variant="ghost" label="New team" icon="Plus" onPress={onNewTeam} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, gap: 16 }}>
          {groups.length === 0 ? (
            <View style={{ padding: 24, borderRadius: 12, backgroundColor: colors.surface1, alignItems: "center", gap: 12 }}>
              <Text style={{ fontSize: ui(14), color: colors.foreground }}>No teams yet</Text>
              <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, textAlign: "center", maxWidth: 420 }}>
                A team is a few bots with a Chief of Staff, who takes your requests and hands parts to the others.
              </Text>
              <Button colors={colors} variant="default" label="New team" icon="Plus" onPress={onNewTeam} />
            </View>
          ) : null}
          {groups.map((group) => {
            const { lead, members } = groupBots(group, live);
            return (
              <Tile key={group.id} colors={colors} title={group.name || "Untitled team"} meta={`${members.length + (lead ? 1 : 0)} ${members.length + (lead ? 1 : 0) === 1 ? "bot" : "bots"}`} onEdit={() => onEditTeam(group)}>
                <View style={compact ? { gap: 8 } : { flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={compact ? undefined : { width: 240 }}>
                    {lead ? card(lead, true) : <Placeholder colors={colors} text="No Chief of Staff yet" />}
                  </View>
                  <View style={{ alignItems: "center" }}>
                    <Icon name={compact ? "ArrowDown" : "ArrowRight"} size={16} color={colors.foregroundMuted} />
                  </View>
                  <View style={{ flex: compact ? undefined : 1, gap: 8 }}>{members.length ? members.map((bot) => card(bot)) : <Placeholder colors={colors} text="No other members" />}</View>
                </View>
              </Tile>
            );
          })}
          {groups.length > 0 && loose.length > 0 ? (
            <Tile colors={colors} title="Bots without a team" meta={`${loose.length} ${loose.length === 1 ? "bot" : "bots"}`}>
              <View style={{ gap: 8 }}>{loose.map((bot) => card(bot))}</View>
            </Tile>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Tile({ colors, title, meta, onEdit, children }: { colors: Colors; title: string; meta: string; onEdit?: () => void; children: ReactNode }) {
  return (
    <View style={{ padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), color: colors.foreground }}>
          {title}
        </Text>
        <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{meta}</Text>
        <View style={{ flex: 1 }} />
        {onEdit ? <Button colors={colors} variant="ghost" label="Edit" icon="Pencil" onPress={onEdit} /> : null}
      </View>
      {children}
    </View>
  );
}

function Placeholder({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ minHeight: 56, borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, alignItems: "center", justifyContent: "center", padding: 12 }}>
      <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{text}</Text>
    </View>
  );
}

const STATUS: Partial<Record<ReturnType<typeof chatBucket>, { label: string; color: (colors: Colors) => string }>> = {
  running: { label: "Working", color: (colors) => colors.statusSuccess },
  needs_input: { label: "Waiting for you", color: (colors) => colors.statusWarning },
  failed: { label: "Failed", color: (colors) => colors.statusDanger },
};

function BotCard({ colors, bot, lead, localHost, onPress }: { colors: Colors; bot: Bot; lead: boolean; localHost: LocalHost; onPress(): void }) {
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const status = STATUS[aggregateBuckets((chats.data ?? []).map(chatBucket))];
  const { hovered, hoverProps } = useHover();
  const agent = [bot.provider, bot.model].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${bot.name}`}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface2 : colors.surface0,
      })}
    >
      <Avatar avatar={bot.avatar} size={32} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), color: colors.foreground }}>
            {bot.name}
          </Text>
          {lead ? <Icon name="Crown" size={12} color={colors.foregroundMuted} /> : null}
        </View>
        {bot.title ? (
          <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
            {bot.title}
          </Text>
        ) : null}
        {agent ? (
          <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
            {agent}
          </Text>
        ) : null}
      </View>
      {status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: status.color(colors) }} />
          <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{status.label}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
