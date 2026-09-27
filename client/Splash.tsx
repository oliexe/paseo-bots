import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { grayscaleAvatar, SPLASH_LINEUP, spriteAvatar } from "../shared/avatar";
import { PLUGIN_VERSION } from "../shared/version";
import { PixelSprite } from "./Avatar";
import { nativeTokens } from "./native";
import { ui } from "./typography";

type Colors = PluginTheme["colors"];

const AVATAR_SIZE = 48;

/** Shown in the chat pane before a bot is picked: six generated bots in grayscale over a small name and version footnote. */
export function Splash({ colors, background }: { colors: Colors; background?: string }) {
  const dark = nativeTokens(colors).dark;
  const lineup = useMemo(
    () =>
      SPLASH_LINEUP.map((entry) => {
        return { key: entry.sprite, gray: grayscaleAvatar(spriteAvatar(entry.sprite, entry.palette, entry.accent, { dark })) };
      }),
    [dark],
  );

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16, backgroundColor: background ?? colors.surface0 }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, maxWidth: 6 * AVATAR_SIZE + 5 * 12 }}>
        {lineup.map((entry) => (
          <PixelSprite key={entry.key} sprite={entry.gray} size={AVATAR_SIZE} />
        ))}
      </View>
      <View style={{ alignItems: "center", gap: 2 }}>
        <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>paseo-bots</Text>
        <Text style={{ fontSize: ui(11), color: colors.foregroundMuted, opacity: 0.7 }}>v{PLUGIN_VERSION}</Text>
      </View>
    </View>
  );
}
