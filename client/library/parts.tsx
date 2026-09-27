import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { Bot } from "../../shared/bot";
import { Avatar } from "../Avatar";
import { confirmDialog, nativeTokens, useHover } from "../native";
import { CardNote, RowText, Switch } from "../panel/controls";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

/** Settings content column: 16 padding, 24 on top, at most 720 wide (settings-screen.tsx). */
export const PAGE_STYLE = { padding: 16, paddingTop: 24, paddingBottom: 32, width: "100%", maxWidth: 720, alignSelf: "center" } as const;

/** The settings page title: 26pt medium, 4 in from the cards, 24 above the first section. Desktop only, like Paseo. */
export function PageTitle({ colors, title }: { colors: Colors; title: string }) {
  return (
    <Text accessibilityRole="header" numberOfLines={2} style={{ marginLeft: 4, marginBottom: 24, fontSize: ui(26), fontWeight: "500", color: colors.foreground }}>
      {title}
    </Text>
  );
}

/** Paseo's BackHeader on compact: 56 high, ArrowLeft 20 in a 12-padded target, the title in ScreenTitle style. */
export function BackBar({ colors, title, backLabel = "Back to Skills & Tools", onBack }: { colors: Colors; title: string; backLabel?: string; onBack(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ height: 56, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        hitSlop={8}
        onPress={onBack}
        {...hoverProps}
        style={({ pressed }) => ({ padding: 12, borderRadius: 8, backgroundColor: hovered || pressed ? nativeTokens(colors).interactionHighlight : "transparent" })}
      >
        <Icon name="ArrowLeft" size={20} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </Pressable>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), color: colors.foreground }}>
        {title}
      </Text>
    </View>
  );
}

/** Every bot with a switch for this library item. */
export function BotsCard({ colors, bots, uses, noun, onToggle }: { colors: Colors; bots: Bot[]; uses(bot: Bot): boolean; noun: string; onToggle(bot: Bot, on: boolean): void }) {
  return (
    <SettingsSection title="Bots" info={`Switched-on bots get this ${noun} in every new chat.`}>
      <SettingsCard>
        {bots.length === 0 ? <CardNote colors={colors} text="No bots yet" /> : null}
        {bots.map((bot) => (
          <View key={bot.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56 }}>
            <Avatar avatar={bot.avatar} size={24} />
            <RowText colors={colors} label={bot.name || "Untitled bot"} hint={bot.archived ? "Archived" : bot.title || null} />
            <Switch colors={colors} label={`Use in ${bot.name}`} value={uses(bot)} onValueChange={(next) => onToggle(bot, next)} />
          </View>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/** A "Danger zone" section with one confirmed destructive action (host-page.tsx). */
export function DangerZone({ label, hint, actionLabel, confirmTitle, confirmMessage, onConfirm }: { label: string; hint: string; actionLabel: string; confirmTitle: string; confirmMessage: string; onConfirm(): void }) {
  return (
    <SettingsSection title="Danger zone">
      <SettingsCard>
        <SettingsAction
          label={label}
          hint={hint}
          actionLabel={actionLabel}
          onPress={() => void confirmDialog({ title: confirmTitle, message: confirmMessage, confirmLabel: actionLabel, destructive: true }).then((confirmed) => confirmed && onConfirm())}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
