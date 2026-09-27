import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import { botSettings, type BotSettingsValues } from "../shared/bot";

export type BotSettingsState = ReturnType<typeof useBotSettingsState>;

function useBotSettingsState() {
  return useSettings(botSettings);
}

/**
 * The bots settings document with one write queue. Every write reads the latest
 * revision when it runs and retries on a conflict, so autosaves, menu actions
 * and the other plugin surface never overwrite each other.
 */
export function useBotSettings() {
  const settings = useBotSettingsState();
  const toast = useToast();
  const latest = useRef(settings);
  latest.current = settings;
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const commit = (mutate: (values: BotSettingsValues) => BotSettingsValues): Promise<boolean> => {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = latest.current;
        if (current.status !== "ready") return false;
        if (await current.save(mutate(current.values), current.revision)) {
          // Let the hook render the new revision before the next queued write reads it.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return true;
        }
        await current.reload();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      toast.error(latest.current.saveError ?? "Couldn't save bots. Try again.");
      return false;
    };
    const result = queue.current.then(run);
    queue.current = result.catch(() => false);
    return result;
  };

  return { settings, latest, commit };
}
