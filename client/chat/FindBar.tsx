import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { CONTENT_MAX_WIDTH, nativeTokens, useHover } from "../native";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

/**
 * Find in chat, over the stream like a browser's find bar. It starts at the
 * newest match: Enter and ↑ go to older ones, Shift+Enter and ↓ to newer.
 */
export function FindBar({
  colors,
  query,
  position,
  total,
  busy,
  onQuery,
  onOlder,
  onNewer,
  onClose,
}: {
  colors: Colors;
  query: string;
  /** 1-based, counted from the oldest match. */
  position: number;
  total: number;
  /** Earlier messages are loading to search them. */
  busy: boolean;
  onQuery(text: string): void;
  onOlder(): void;
  onNewer(): void;
  onClose(): void;
}) {
  const tokens = nativeTokens(colors);
  const input = useRef<TextInput>(null);
  useEffect(() => input.current?.focus(), []);
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean }>) => {
    const { key, shiftKey } = event.nativeEvent;
    if (key === "Escape") onClose();
    else if (key === "Enter") {
      event.preventDefault();
      if (shiftKey) onNewer();
      else onOlder();
    }
  };
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface0 }}>
      <View
        style={{
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 4,
          paddingLeft: 12,
          paddingRight: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: tokens.borderAccent,
          backgroundColor: colors.surface2,
        }}
      >
        <Icon name="Search" size={14} color={colors.foregroundMuted} />
        <TextInput
          ref={input}
          accessibilityLabel="Find in this chat"
          value={query}
          onChangeText={onQuery}
          onKeyPress={Platform.OS === "web" ? onKeyPress : undefined}
          onSubmitEditing={Platform.OS === "web" ? undefined : onOlder}
          blurOnSubmit={false}
          placeholder="Find in this chat"
          placeholderTextColor={colors.foregroundMuted}
          selectionColor={colors.foreground}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, padding: 0, height: 24, fontSize: ui(14), color: colors.foreground, outlineWidth: 0 }}
        />
        {busy ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
        {!busy && query.trim() ? <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{total ? `${position} of ${total}` : "No matches"}</Text> : null}
        <FindButton colors={colors} icon="ChevronUp" label="Older match" onPress={onOlder} />
        <FindButton colors={colors} icon="ChevronDown" label="Newer match" onPress={onNewer} />
        <FindButton colors={colors} icon="X" label="Close find" onPress={onClose} />
      </View>
    </View>
  );
}

function FindButton({ colors, icon, label, onPress }: { colors: Colors; icon: string; label: string; onPress(): void }) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({ width: 24, height: 24, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: hovered || pressed ? tokens.interactionHighlight : "transparent" })}
    >
      <Icon name={icon} size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}
