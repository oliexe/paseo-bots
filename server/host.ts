import type { PaseoApi } from "./paseo";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { BOT_LABEL, EMPTY_LIBRARY, type Bot, type BotSettingsValues, type botSettings, type Library } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import type { RoutineService } from "./routine-service";

// What every server feature needs: the saved settings (read-only on the
// server), and the plugin's Paseo API. The SDK only hands the API out inside
// RPC handlers and lifecycle hooks. A server-owned SDK connection supplies the
// initial API when no app is open; the plugin session takes over on first use.

type Listener = (paseo: PaseoApi) => void;

export class BotsHost {
  private api: PaseoApi | null = null;
  private readonly listeners = new Set<Listener>();
  private borrowed = false;
  bootstrapError: string | null = null;
  private routineService: RoutineService | null = null;

  constructor(readonly settings: PluginSettings<typeof botSettings.schema>) {}

  attachRoutines(service: RoutineService): () => void {
    this.routineService = service;
    return () => { if (this.routineService === service) this.routineService = null; };
  }

  requireRoutines(): RoutineService {
    if (!this.routineService) throw new Error("The routine scheduler is not available. Reopen the Bots plugin and try again.");
    return this.routineService;
  }

  attach(paseo: PaseoApi, fallback = false): void {
    if (fallback && this.borrowed) return;
    this.borrowed ||= !fallback;
    this.bootstrapError = null;
    if (this.api === paseo) return;
    this.api = paseo;
    for (const listener of this.listeners) listener(paseo);
  }

  onAttach(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.api) listener(this.api);
    return () => { this.listeners.delete(listener); };
  }

  get hasPluginApi(): boolean { return this.borrowed; }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  /** The Paseo API, or an error a tool can show the agent. */
  requirePaseo(): PaseoApi {
    if (!this.api) throw new Error(this.bootstrapError ?? "Paseo is still connecting. Try again shortly.");
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

  private readonly chatBots = new Map<string, string | null>();

  /** A bot chat's bot, its current title (Paseo names chats after their first message), routine and labels; null for other agents. */
  async chatOf(agentId: string): Promise<{ botId: string; title: string | null; routineId: string | null; labels: Record<string, string> } | null> {
    if (this.chatBots.get(agentId) === null) return null;
    const snapshot = await this.paseo?.agents.ref(agentId).refresh().catch(() => null);
    if (!snapshot) return null;
    const botId = snapshot.agent.labels?.[BOT_LABEL] ?? null;
    if (this.chatBots.size > 500) this.chatBots.clear();
    this.chatBots.set(agentId, botId);
    const labels = snapshot.agent.labels ?? {};
    return botId ? { botId, title: snapshot.agent.title ?? null, routineId: labels[ROUTINE_LABEL] ?? null, labels } : null;
  }

  /** The bot a chat belongs to, from the label it was created with; null for other agents. */
  async botIdOf(agentId: string): Promise<string | null> {
    const known = this.chatBots.get(agentId);
    return known !== undefined ? known : ((await this.chatOf(agentId))?.botId ?? null);
  }
}
