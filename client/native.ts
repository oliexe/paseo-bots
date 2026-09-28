// Values mirror Paseo's own app styles (packages/app/src/styles/theme.ts and the
// sidebar, agent-stream and composer components) so the Bots surface reads as native.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Alert, Platform } from "react-native";

type Colors = PluginTheme["colors"];

/** Paseo's code font stacks (styles/theme.ts DEFAULT_MONO_FONT_STACK and native defaults). */
export const MONO_FONT = Platform.select({
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  ios: "ui-monospace",
  default: "monospace",
});

/**
 * Spread onto monospace <Text>. On web Paseo forces its UI font onto every
 * element except those marked `data-pmono` (appearance/apply-root-font.web.ts),
 * so code text must carry the marker to keep its monospace font.
 */
export const MONO_PROPS = (Platform.OS === "web" ? { dataSet: { pmono: "" } } : {}) as object;

/** Paseo's stream and composer column width. */
export const CONTENT_MAX_WIDTH = 820;

/** Pressable hover tracking (web/desktop); stays false on touch devices. */
export function useHover() {
  const [hovered, setHovered] = useState(false);
  return { hovered, hoverProps: { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) } };
}

// ---------------------------------------------------------------- colours

type Rgba = [number, number, number, number];

function parseColor(color: string): Rgba | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
    const n = parseInt(digits.slice(0, 6), 16);
    const alpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value);
  if (rgb) {
    const alpha = rgb[4] ? (rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])) : 1;
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  return null;
}

/** A thrown error as one readable line: without Paseo's RPC wrapper ("Request failed: … requestType=… code=…") or a trailing period. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Request failed:\s*/, "")
    .replace(/\s+requestType=\S+(\s+code=\S+)?\s*$/, "")
    .trim()
    .replace(/\.$/, "");
}

/** Blend two colours (`weight` of `a`); returns `a` when either can't be parsed. */
function mix(a: string, b: string, weight: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  const channel = (i: number) => Math.round(x[i]! * weight + y[i]! * (1 - weight)).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : color;
}

function isDark(colors: Colors): boolean {
  const c = parseColor(colors.surface0);
  if (!c) return true;
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5;
}

/**
 * Paseo theme tokens the plugin theme doesn't carry, derived from the ones it
 * does. Weights are calibrated so the default Paseo dark and light themes
 * reproduce the real values (styles/theme.ts paseoDarkColors / light tint).
 */
export interface NativeTokens {
  dark: boolean;
  surfaceSidebar: string;
  /** Selected sidebar row: surface2 in dark themes, surface3 in light. */
  surfaceSidebarSelected: string;
  surface3: string;
  surface4: string;
  borderAccent: string;
  foregroundExtraMuted: string;
  accentBright: string;
  interactionHighlight: string;
  statusDotRunning: string;
  statusDotSuccess: string;
  statusDotWarning: string;
  statusDotDanger: string;
}

const cache = new WeakMap<Colors, NativeTokens>();

export function nativeTokens(colors: Colors): NativeTokens {
  const cached = cache.get(colors);
  if (cached) return cached;
  const dark = isDark(colors);
  const surface3 = mix(colors.surface2, colors.foreground, dark ? 0.87 : 0.93);
  const tokens: NativeTokens = {
    dark,
    surfaceSidebar: dark ? mix(colors.surface0, "#000000", 0.83) : colors.surface2,
    surfaceSidebarSelected: dark ? colors.surface2 : surface3,
    surface3,
    surface4: mix(colors.surface2, colors.foreground, dark ? 0.76 : 0.85),
    borderAccent: dark ? mix(colors.border, colors.foreground, 0.95) : mix(colors.border, colors.surface0, 0.7),
    foregroundExtraMuted: mix(colors.foregroundMuted, colors.surface0, 0.65),
    accentBright: mix(colors.accent, "#ffffff", dark ? 0.37 : 0.75),
    interactionHighlight: dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
    statusDotRunning: dark ? "#5caaf6" : "#268ae0",
    statusDotSuccess: dark ? "#35c264" : "#299f51",
    statusDotWarning: dark ? "#db932e" : "#b37824",
    statusDotDanger: dark ? "#f7796d" : "#f12e2f",
  };
  cache.set(colors, tokens);
  return tokens;
}

/** Paseo's composer placeholder colour (surface4). */
export function placeholderColor(colors: Colors): string {
  return nativeTokens(colors).surface4;
}

// ---------------------------------------------------------------- confirm

export interface ConfirmInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

// This plugin typechecks without the DOM library. Declare only what this module uses.
const host = globalThis as unknown as {
  paseoDesktop?: { dialog?: { ask?: (message: string, options: { title: string; okLabel: string; cancelLabel: string; kind: "warning" | "info" }) => Promise<boolean> } };
  confirm?: (message?: string) => boolean;
  document?: { activeElement?: { blur?: () => void } | null };
};

/** Paseo's confirmDialog (utils/confirm-dialog.ts): Alert on phones, the Electron dialog on desktop, confirm() on web. */
export async function confirmDialog(input: ConfirmInput): Promise<boolean> {
  const confirmLabel = input.confirmLabel ?? "Confirm";
  const cancelLabel = input.cancelLabel ?? "Cancel";
  if (Platform.OS !== "web") {
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        input.title,
        input.message,
        [
          { text: cancelLabel, style: "cancel", onPress: () => resolve(false) },
          { text: confirmLabel, style: input.destructive ? "destructive" : "default", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
  }
  host.document?.activeElement?.blur?.();
  const ask = host.paseoDesktop?.dialog?.ask;
  if (typeof ask === "function") {
    return ask(input.message, { title: input.title, okLabel: confirmLabel, cancelLabel, kind: input.destructive ? "warning" : "info" });
  }
  return host.confirm ? host.confirm(`${input.title}\n\n${input.message}`) : false;
}
