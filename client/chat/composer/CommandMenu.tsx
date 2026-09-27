import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { nativeTokens } from "../../native";
import { ui } from "../../typography";
import type { SlashCommand } from "./logic";

type Colors = PluginTheme["colors"];

/**
 * Paseo's /command autocomplete (components/ui/autocomplete.tsx) shown 12 above the input:
 * a surface1 card with a borderAccent frame, radius 8, max 220 high, rows 36 high with the
 * command in 14pt and its description muted in 12pt.
 */
export function CommandMenu({
  colors,
  commands,
  activeIndex,
  loading,
  error,
  onHover,
  onSelect,
}: {
  colors: Colors;
  commands: readonly SlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  onHover(index: number): void;
  onSelect(command: SlashCommand): void;
}) {
  const tokens = nativeTokens(colors);
  const empty = loading ? "Loading..." : error ?? "No results found.";
  return (
    <View
      accessibilityRole="menu"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "100%",
        marginBottom: 12,
        maxHeight: 220,
        zIndex: 10,
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: tokens.borderAccent,
        borderRadius: 8,
        overflow: "hidden",
        shadowColor: tokens.dark ? "rgba(0, 0, 0, 0.20)" : "rgba(0, 0, 0, 0.04)",
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: tokens.dark ? 8 : 16,
        elevation: 8,
      }}
    >
      {commands.length === 0 ? (
        <View style={{ paddingHorizontal: 12, paddingVertical: 12 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>{empty}</Text>
        </View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="always" style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
          {commands.map((command, index) => (
            <Pressable
              key={`${command.kind ?? "command"}:${command.name}`}
              accessibilityRole="menuitem"
              accessibilityLabel={`/${command.name}`}
              onHoverIn={() => onHover(index)}
              onPress={() => onSelect(command)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 36,
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: index === activeIndex ? colors.surface2 : "transparent",
              }}
            >
              <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "50%", color: colors.foreground, fontSize: ui(14) }}>
                {`/${command.name}`}
                {command.argumentHint ? <Text style={{ color: colors.foregroundMuted }}>{` ${command.argumentHint}`}</Text> : null}
              </Text>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: ui(12) }}>
                {command.description}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
