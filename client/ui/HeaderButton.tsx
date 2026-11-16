import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable } from "react-native";
import { nativeTokens, useHover } from "../native";
import { tooltip } from "./Tooltip";

type Colors = PluginTheme["colors"];

/** The existing chat toolbar button, shared by Bots screens. */
export function HeaderButton({ colors, compact, icon, label, expanded, onPress }: { colors: Colors; compact: boolean; icon: string; label: string; expanded?: boolean; onPress(): void }) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  const size = compact ? 32 : 26;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
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
