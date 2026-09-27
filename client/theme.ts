import type { PluginTheme } from "@getpaseo/plugin";
import type { TextStyle } from "react-native";
import { MONO_FONT, nativeTokens } from "./native";
import { code, ui } from "./typography";

type Colors = PluginTheme["colors"];

/**
 * A multi-line field at rest, shaped like Paseo's FormTextInput (components/ui/form-field.tsx,
 * control-geometry.ts): surface2 fill, transparent 1px border, radius 6, 12/6 padding, 14pt text.
 * Hover and focus need state; `FormTextArea` in panel/controls.tsx adds the borderAccent hover
 * and the 2px accent focus ring on top of this.
 */
export function multilineStyle(colors: Colors, minHeight: number, monospace = false): TextStyle {
  return {
    width: "100%",
    minHeight,
    color: colors.foreground,
    backgroundColor: colors.surface2,
    borderColor: "transparent",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: monospace ? code() : ui(14),
    lineHeight: Math.round((monospace ? code() : ui(14)) * 1.4),
    textAlignVertical: "top",
    fontFamily: monospace ? MONO_FONT : undefined,
    outlineWidth: 0,
    outlineColor: "transparent",
  };
}

/** FormTextInput's interaction layers (control-geometry.ts controlHover / controlActive). */
export function fieldStateStyle(colors: Colors, state: { hovered: boolean; focused: boolean; disabled?: boolean }): TextStyle {
  if (state.disabled) return { opacity: 0.5 };
  if (state.focused) {
    return { borderColor: nativeTokens(colors).borderAccent, outlineColor: colors.accent, outlineOffset: 1, outlineStyle: "solid", outlineWidth: 2 };
  }
  return state.hovered ? { borderColor: nativeTokens(colors).borderAccent } : {};
}
