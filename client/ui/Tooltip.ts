import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect } from "react";
import { Platform } from "react-native";
import { nativeTokens } from "../native";
import { ui } from "../typography";

// Paseo's Tooltip (components/ui/tooltip.tsx) for the plugin's icon buttons. Plugins
// can't reach react-dom's portal, so one DOM bubble, shared by every button, follows
// the pointer: a button tagged with `tooltip("Label")` shows it after Paseo's 300ms,
// above it (below when there's no room), with Paseo's popover look. Like Paseo it's a
// desktop affordance: touch and the compact layout get none.

type Colors = PluginTheme["colors"];
type Side = "top" | "bottom";

interface El {
  closest(selector: string): El | null;
  contains(node: unknown): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
interface Bubble {
  textContent: string;
  style: Record<string, string>;
  offsetWidth: number;
  offsetHeight: number;
  appendChild(node: Bubble): void;
  remove(): void;
}
interface PointerEventLike {
  target: unknown;
  relatedTarget: unknown;
  pointerType?: string;
}
declare const document: {
  createElement(tag: "div"): Bubble;
  body: { appendChild(node: Bubble): void };
  addEventListener(type: string, listener: (event: PointerEventLike & { key?: string }) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: PointerEventLike & { key?: string }) => void, capture: boolean): void;
};
declare const window: { innerWidth: number; innerHeight: number; getComputedStyle(element: unknown): { fontFamily: string } };

const web = Platform.OS === "web";
const SELECTOR = "[data-pb-tip]";
const DELAY_MS = 300;
const OFFSET = 8;
const EDGE = 8;
/** Paseo's compact breakpoint (styles/unistyles.ts: md starts at 720). */
const COMPACT_WIDTH = 720;
const UI_FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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
  return web && typeof window !== "undefined" && window.innerWidth >= COMPACT_WIDTH;
}

let colors: Colors | null = null;

/** Keeps the bubble in the current theme; call it where plugin UI renders. */
export function useTooltipTheme(theme: Colors): void {
  useEffect(() => {
    colors = theme;
  }, [theme]);
}

/** Starts the shared tooltip on web; returns its cleanup. */
export function installTooltips(): () => void {
  if (!web || typeof document === "undefined") return () => {};
  let anchor: El | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let bubble: Bubble | null = null;

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    anchor = null;
    if (bubble) bubble.style.opacity = "0";
  };

  const show = (target: El) => {
    const label = target.getAttribute("data-pb-tip");
    if (!label || !tooltipsShown()) return;
    const theme = colors;
    const tokens = theme ? nativeTokens(theme) : null;
    const dark = tokens?.dark ?? true;
    bubble ??= document.createElement("div");
    Object.assign(bubble.style, {
      position: "fixed",
      zIndex: "2147483000",
      pointerEvents: "none",
      maxWidth: "280px",
      padding: "4px 8px",
      borderRadius: "12px",
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: tokens?.borderAccent ?? "#3a3d42",
      backgroundColor: theme ? (dark ? theme.surface2 : theme.surface0) : "#202225",
      color: theme?.foreground ?? "#e6e6e6",
      boxShadow: dark ? "0 4px 8px rgba(0, 0, 0, 0.20)" : "0 4px 16px rgba(0, 0, 0, 0.04)",
      fontFamily: window.getComputedStyle(target).fontFamily || UI_FONT,
      fontSize: `${ui(14)}px`,
      lineHeight: "1.4",
      whiteSpace: "normal",
      transition: "opacity 80ms ease-out",
      opacity: "0",
      left: "-9999px",
      top: "-9999px",
    });
    const lines = target.getAttribute("data-pb-tip-lines")?.split("\n") ?? [];
    const details = target.getAttribute("data-pb-tip-details")?.split("\n") ?? [];
    bubble.style.minWidth = details.length ? "200px" : "0";
    bubble.textContent = "";
    // Paseo's context meter tooltip: foreground 14pt lines, then muted 12pt details, 6 apart.
    [label, ...lines, ...details].forEach((text, index) => {
      const line = document.createElement("div");
      line.textContent = text;
      const detail = index > lines.length;
      Object.assign(line.style, {
        marginTop: index === 0 ? "0" : "6px",
        color: detail ? (theme?.foregroundMuted ?? "#a1a1aa") : "inherit",
        fontSize: detail ? `${ui(12)}px` : "inherit",
      });
      bubble?.appendChild(line);
    });
    document.body.appendChild(bubble);
    const rect = target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const wanted = (target.getAttribute("data-pb-tip-side") as Side | null) ?? "top";
    const above = rect.top - height - OFFSET;
    const below = rect.top + rect.height + OFFSET;
    // Paseo flips to the other side when the preferred one hasn't the room.
    const side: Side = wanted === "top" ? (above < EDGE && below + height <= window.innerHeight - EDGE ? "bottom" : "top") : below + height > window.innerHeight - EDGE && above >= EDGE ? "top" : "bottom";
    const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, rect.left + (rect.width - width) / 2));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${side === "top" ? above : below}px`;
    bubble.style.opacity = "1";
  };

  const over = (event: PointerEventLike) => {
    if (event.pointerType === "touch") return;
    const target = (event.target as El | null)?.closest?.(SELECTOR) ?? null;
    if (target === anchor) return;
    hide();
    if (!target) return;
    anchor = target;
    timer = setTimeout(
      () => {
        timer = null;
        if (anchor === target) show(target);
      },
      Number(target.getAttribute("data-pb-tip-delay") ?? DELAY_MS),
    );
  };
  const out = (event: PointerEventLike) => {
    if (anchor && !anchor.contains(event.relatedTarget)) hide();
  };
  const key = (event: { key?: string }) => {
    if (event.key === "Escape") hide();
  };

  document.addEventListener("pointerover", over, true);
  document.addEventListener("pointerout", out, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("wheel", hide, true);
  return () => {
    hide();
    bubble?.remove();
    document.removeEventListener("pointerover", over, true);
    document.removeEventListener("pointerout", out, true);
    document.removeEventListener("pointerdown", hide, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("scroll", hide, true);
    document.removeEventListener("wheel", hide, true);
  };
}
