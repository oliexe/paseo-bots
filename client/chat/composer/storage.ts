import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { AppState, NativeModules, Platform, TurboModuleRegistry } from "react-native";
import { deviceStorage } from "../../../shared/device-storage";
import { DeviceStore } from "../../device-store";
import { readWebStorage } from "../../web";
import { DEFAULT_SEND_BEHAVIOR, parseSendBehavior, type SendBehavior } from "./logic";

// The public plugin API retains one Paseo object per installation across surfaces.
// Each host installation keeps a separate, device-only draft document.
const stores = new WeakMap<object, DeviceStore>();

export function useDeviceStorage(): DeviceStore {
  const paseo = usePaseo();
  const settings = useSettings(deviceStorage);
  const toast = useToast();
  let store = stores.get(paseo);
  if (!store) {
    store = new DeviceStore((key) => key.startsWith("@paseo-bots:") ? readWebStorage(key) : null);
    stores.set(paseo, store);
  }
  const current = store;
  useEffect(() => current.subscribe(() => { const error = current.takeError(); if (error) toast.error(error); }), [current, toast]);
  useEffect(() => { current.update(settings); }, [current, settings]);
  return current;
}

const APP_SETTINGS_KEY = "@paseo:app-settings";
const native = Platform.OS !== "web";
type AsyncStorageModule = { multiGet(keys: string[], callback: (errors: unknown, result: [string, string | null][] | null) => void): void };

// Preserve the existing host preference bridge. Drafts use the separate public
// device settings store above; they never write Paseo's application settings.
function readHostSettings(): Promise<string | null> {
  if (!native) return Promise.resolve(readWebStorage(APP_SETTINGS_KEY));
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 1_000);
    const finish = (value: string | null) => { clearTimeout(timeout); resolve(value); };
    try {
      const storage = (TurboModuleRegistry.get("RNCAsyncStorage") as AsyncStorageModule | null) ?? (NativeModules.RNCAsyncStorage as AsyncStorageModule | undefined);
      if (!storage?.multiGet) finish(null);
      else storage.multiGet([APP_SETTINGS_KEY], (_errors, result) => finish(result?.[0]?.[1] ?? null));
    } catch { finish(null); }
  });
}

let sendBehavior: SendBehavior = native ? DEFAULT_SEND_BEHAVIOR : parseSendBehavior(readWebStorage(APP_SETTINGS_KEY));

/** Follow Paseo's “When the agent is working” preference, including later changes. */
export function useSendBehavior(): SendBehavior {
  const [value, setValue] = useState(sendBehavior);
  useEffect(() => {
    let alive = true;
    const refresh = () => void readHostSettings().then((stored) => {
      if (!alive) return;
      sendBehavior = parseSendBehavior(stored);
      setValue(sendBehavior);
    });
    refresh();
    const timer = native ? null : setInterval(refresh, 2_000);
    const subscription = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => { alive = false; if (timer) clearInterval(timer); subscription.remove(); };
  }, []);
  return value;
}
