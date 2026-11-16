import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect } from "react";
import { Platform } from "react-native";
import { nativeTokens } from "../native";
import { ui } from "../typography";
import { installWebTooltips, webTooltipsShown } from "../web";

// Paseo's Tooltip (components/ui/tooltip.tsx) for the plugin's icon buttons. Plugins
// can't reach react-dom's portal, so one DOM bubble, shared by every button, follows
// the pointer: a button tagged with `tooltip("Label")` shows it after Paseo's 300ms,
// above it (below when there's no room), with Paseo's popover look. Like Paseo it's a
// desktop affordance: touch and the compact layout get none.

type Colors = PluginTheme["colors"];
type Side = "top" | "bottom";

const web = Platform.OS === "web";

interface TooltipExtras {
  /** Lines under the label in the same type, like Paseo's context meter "42% used". */
  lines?: string[];
  /** Muted 12pt lines at the end. */
  details?: string[];
  /** Milliseconds before it opens: Paseo's icon buttons wait 300, its tabs 400, its context meter 0. */
  delay?: number;
}

/** Props that give an icon button Paseo's tooltip. Spread them on the Pressable next to its accessibilityLabel. */
export function tooltip(label: string, side: Side = "top", extras: TooltipExtras = {}): object {
  if (!web) return {};
  const dataSet: Record<string, string> = { pbTip: label, pbTipSide: side };
  if (extras.lines?.length) dataSet.pbTipLines = extras.lines.join("\n");
  if (extras.details?.length) dataSet.pbTipDetails = extras.details.join("\n");
  if (extras.delay !== undefined) dataSet.pbTipDelay = String(extras.delay);
  return { dataSet };
}

/** Whether hovering shows tooltips here: Paseo's are a desktop affordance. */
export function tooltipsShown(): boolean {
  return webTooltipsShown();
}

let colors: Colors | null = null;

/** Keeps the bubble in the current theme; call it where plugin UI renders. */
export function useTooltipTheme(theme: Colors): void {
  useEffect(() => {
    colors = theme;
  }, [theme]);
}

/** Installs the browser tooltip; native clients receive a no-op cleanup. */
export function installTooltips(): () => void {
  return installWebTooltips(() => {
    const theme = colors;
    const tokens = theme ? nativeTokens(theme) : null;
    const dark = tokens?.dark ?? true;
    return {
      borderColor: tokens?.borderAccent ?? "#3a3d42",
      backgroundColor: theme ? (dark ? theme.surface2 : theme.surface0) : "#202225",
      color: theme?.foreground ?? "#e6e6e6",
      mutedColor: theme?.foregroundMuted ?? "#a1a1aa",
      boxShadow: dark ? "0 4px 8px rgba(0, 0, 0, 0.20)" : "0 4px 16px rgba(0, 0, 0, 0.04)",
      fontSize: ui(14),
      detailFontSize: ui(12),
    };
  });
}
