import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { EMPTY_LIBRARY, type Bot, type BotSettingsValues, type botSettings, type Library } from "../shared/bot";

// What every server feature needs: the saved settings (read-only on the
// server), and the plugin's Paseo API. The SDK only hands the API out inside
// RPC handlers and lifecycle hooks, so it's captured the first time one runs
// (the app calls `bots.hello` on start) and features wait for it.

type Listener = (paseo: PaseoApi) => void;

export class BotsHost {
  private api: PaseoApi | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(readonly settings: PluginSettings<typeof botSettings.schema>) {}

  attach(paseo: PaseoApi): void {
    if (this.api === paseo) return;
    this.api = paseo;
    for (const listener of this.listeners) listener(paseo);
  }

  onAttach(listener: Listener): void {
    this.listeners.add(listener);
    if (this.api) listener(this.api);
  }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  /** The Paseo API, or an error a tool can show the agent. */
  requirePaseo(): PaseoApi {
    if (!this.api) throw new Error("paseo-bots isn't connected to Paseo yet. Open the Bots screen once and try again.");
    return this.api;
  }

  async values(): Promise<BotSettingsValues | null> {
    const state = await this.settings.read();
    return state.status === "ready" ? state.values : null;
  }

  async library(): Promise<Library> {
    return (await this.values())?.library ?? EMPTY_LIBRARY;
  }

  async bots(): Promise<Bot[]> {
    return (await this.values())?.bots ?? [];
  }

  async bot(botId: string): Promise<Bot | null> {
    return (await this.bots()).find((bot) => bot.id === botId) ?? null;
  }
}
