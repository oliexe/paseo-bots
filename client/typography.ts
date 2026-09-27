import { useEffect, useState } from "react";
import { AppState, NativeModules, Platform, TurboModuleRegistry } from "react-native";

// Paseo scales its UI from the user's Appearance settings (interface, content and
// code sizes), but the plugin theme only carries colours. This reads the same
// persisted settings the app does: `@paseo:app-settings` in localStorage on web and
// desktop, AsyncStorage on phones. Everything falls back to Paseo's own defaults.

const SETTINGS_KEY = "@paseo:app-settings";
const native = Platform.OS !== "web";
/** Paseo's authored UI base size; every UI size scales from it (appearance/apply.ts). */
const AUTHORED_UI_BASE = 14;

export interface TypeScale {
  ui: number;
  content: number;
  code: number;
}

const DEFAULTS: TypeScale = { ui: native ? 15 : 14, content: native ? 16 : 15, code: 12 };
let current: TypeScale = DEFAULTS;

/** Paseo's numeric parsing (hooks/use-settings/storage.ts): numbers or numeric strings, floored, clamped. */
function readNumber(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function parse(raw: string | null | undefined): TypeScale {
  if (!raw) return DEFAULTS;
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    // Older versions stored `uiFontSize` on a 16pt scale; Paseo converts it to the 14pt base.
    const legacy = readNumber(stored.uiFontSize, 11, 24);
    const ui = readNumber(stored.uiBaseFontSize, 10, 21) ?? (legacy !== undefined ? Math.min(21, Math.max(10, Math.round((14 * legacy) / 16))) : DEFAULTS.ui);
    // A missing content size follows the interface size when one was stored.
    const hasUi = stored.uiBaseFontSize !== undefined || legacy !== undefined;
    return {
      ui,
      content: readNumber(stored.contentFontSize, 10, 21) ?? (hasUi ? ui : DEFAULTS.content),
      code: readNumber(stored.codeFontSize, 9, 22) ?? DEFAULTS.code,
    };
  } catch {
    return DEFAULTS;
  }
}

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const localStorage: { getItem(key: string): string | null } | undefined;

type AsyncStorageModule = { multiGet(keys: string[], callback: (errors: unknown, result: [string, string | null][] | null) => void): void };

function readNative(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const storage =
        (TurboModuleRegistry.get("RNCAsyncStorage") as AsyncStorageModule | null) ?? (NativeModules.RNCAsyncStorage as AsyncStorageModule | undefined);
      if (!storage?.multiGet) return resolve(null);
      storage.multiGet([SETTINGS_KEY], (_errors, result) => resolve(result?.[0]?.[1] ?? null));
    } catch {
      resolve(null);
    }
  });
}

async function readScale(): Promise<TypeScale> {
  if (native) return parse(await readNative());
  try {
    return parse(typeof localStorage === "undefined" ? null : localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULTS;
  }
}

/** Interface text scaled like Paseo's ramp: `ui(14)` is the base size. */
export function ui(size: number): number {
  return Math.round((size * current.ui) / AUTHORED_UI_BASE);
}

/** Chat message text (Paseo's "content" size) and its line height. */
export function content(): number {
  return current.content;
}

export function contentLine(): number {
  return Math.round(current.content * 1.4);
}

/** Markdown headings and other content-relative sizes, from Paseo's 15pt authoring. */
export function contentScaled(size: number): number {
  return Math.round((size * current.content) / 15);
}

export function code(): number {
  return current.code;
}

export function codeLine(): number {
  return Math.round(current.code * 1.45);
}

/**
 * Loads the user's sizes and re-reads them when they may have changed (every few
 * seconds on web, on foreground on phones). Returns a version that bumps on change,
 * so the surface re-renders its tree with the new sizes.
 */
export function useTypeScale(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void readScale().then((next) => {
        if (!alive || (next.ui === current.ui && next.content === current.content && next.code === current.code)) return;
        current = next;
        setVersion((value) => value + 1);
      });
    refresh();
    const timer = native ? null : setInterval(refresh, 2000);
    const subscription = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return version;
}
