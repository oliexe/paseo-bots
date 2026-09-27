import { useEffect, useState } from "react";
import { AppState, NativeModules, Platform, TurboModuleRegistry } from "react-native";
import { parseSendBehavior, DEFAULT_SEND_BEHAVIOR, type SendBehavior } from "./logic";

// Persistence for the composer, the same way typography.ts reads Paseo's settings:
// localStorage on web and desktop, the app's AsyncStorage TurboModule on phones.
// Everything is best effort; a missing module or a full quota just means no persistence.

const APP_SETTINGS_KEY = "@paseo:app-settings";
const native = Platform.OS !== "web";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined;

type AsyncStorageModule = {
  multiGet(keys: string[], callback: (errors: unknown, result: [string, string | null][] | null) => void): void;
  multiSet?(pairs: [string, string][], callback: (errors: unknown) => void): void;
};

function asyncStorage(): AsyncStorageModule | null {
  try {
    return (TurboModuleRegistry.get("RNCAsyncStorage") as AsyncStorageModule | null) ?? (NativeModules.RNCAsyncStorage as AsyncStorageModule | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Synchronous read on web; null on phones (use `readItem`). */
export function readItemSync(key: string): string | null {
  if (native) return null;
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readItem(key: string): Promise<string | null> {
  if (!native) return Promise.resolve(readItemSync(key));
  return new Promise((resolve) => {
    const storage = asyncStorage();
    if (!storage?.multiGet) return resolve(null);
    try {
      storage.multiGet([key], (_errors, result) => resolve(result?.[0]?.[1] ?? null));
    } catch {
      resolve(null);
    }
  });
}

export function writeItem(key: string, value: string): Promise<void> {
  if (!native) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      // Quota exceeded or storage disabled.
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const storage = asyncStorage();
    if (!storage?.multiSet) return resolve();
    try {
      storage.multiSet([[key, value]], () => resolve());
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------- send behaviour

let sendBehavior: SendBehavior = native ? DEFAULT_SEND_BEHAVIOR : parseSendBehavior(readItemSync(APP_SETTINGS_KEY));

/** Re-reads Paseo's `sendBehavior` setting. */
export async function readSendBehavior(): Promise<SendBehavior> {
  sendBehavior = parseSendBehavior(await readItem(APP_SETTINGS_KEY));
  return sendBehavior;
}

/** The user's "When the agent is working" setting (steer, interrupt or queue), kept fresh like the type scale. */
export function useSendBehavior(): SendBehavior {
  const [value, setValue] = useState(sendBehavior);
  useEffect(() => {
    let alive = true;
    const refresh = () => void readSendBehavior().then((next) => alive && setValue(next));
    refresh();
    const timer = native ? null : setInterval(refresh, 2000);
    const subscription = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return value;
}
