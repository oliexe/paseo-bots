import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { EMPTY_LIBRARY, type Bot, type Library, type Routine } from "../shared/bot";
import type { botSettings } from "../shared/bot";
import { ROUTINE_LABEL, startBotChat } from "../shared/chat";
import type { RoutineRunState } from "../shared/rpc";
import { decide } from "../shared/routines";
import { ensureBotHome, pluginDataPath } from "./bot-home";
import { systemPrompt } from "./prompt";
import type { AppsRelay } from "./relay";

const TICK_MS = 30_000;
type Runs = Record<string, RoutineRunState>;
const EMPTY: RoutineRunState = { lastRunAt: null, lastStatus: null, lastError: null, lastAgentId: null };

function statePath(): string {
  return join(pluginDataPath(), "routines.json");
}

async function readRuns(): Promise<Runs> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as Runs;
  } catch {
    return {};
  }
}

async function writeRuns(runs: Runs): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(runs, null, 2), "utf8");
}

/**
 * Runs bot routines on this host. The plugin SDK only hands out the Paseo API
 * inside RPC handlers and lifecycle hooks, so the scheduler idles until one of
 * those has run (the app calls `bots.hello` when it starts).
 */
export class RoutineScheduler {
  private paseo: PaseoApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly settings: PluginSettings<typeof botSettings.schema>,
    private readonly relay: AppsRelay,
  ) {}

  attach(paseo: PaseoApi): void {
    if (this.paseo === paseo) return;
    this.paseo = paseo;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    }
  }

  get running(): boolean {
    return this.paseo !== null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.paseo = null;
  }

  async status() {
    return { scheduler: this.running, runs: await readRuns() };
  }

  async runNow(botId: string, routineId: string): Promise<{ agentId: string }> {
    const { bot, routine, library } = await this.find(botId, routineId);
    const runs = await readRuns();
    const agentId = await this.start(bot, routine, library);
    runs[routine.id] = { lastRunAt: new Date().toISOString(), lastStatus: "started", lastError: null, lastAgentId: agentId };
    await writeRuns(runs);
    return { agentId };
  }

  private async find(botId: string, routineId: string): Promise<{ bot: Bot; routine: Routine; library: Library }> {
    const state = await this.settings.read();
    if (state.status !== "ready") throw new Error("Bot settings are unreadable.");
    const bot = state.values.bots.find((entry) => entry.id === botId);
    const routine = bot?.routines.find((entry) => entry.id === routineId);
    if (!bot || !routine) throw new Error("Routine not found.");
    return { bot, routine, library: state.values.library ?? EMPTY_LIBRARY };
  }

  private async start(bot: Bot, routine: Routine, library: Library): Promise<string> {
    if (!this.paseo) throw new Error("The scheduler isn't connected yet. Open Paseo and try again.");
    if (bot.hostId) throw new Error("Routines run on the host that stores the bot; this bot runs on another host.");
    const home = await ensureBotHome({ botId: bot.id });
    const { systemPrompt: prompt } = await systemPrompt({ bot, local: true }, library, this.paseo);
    return startBotChat(this.paseo, {
      bot,
      library,
      apps: bot.apps.length ? await this.relay.mount(bot.id) : null,
      placement: bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root },
      prompt: routine.prompt,
      systemPrompt: prompt,
      title: routine.name,
      labels: { [ROUTINE_LABEL]: routine.id },
    });
  }

  private async busy(agentId: string | null): Promise<boolean> {
    if (!agentId || !this.paseo) return false;
    try {
      const result = await this.paseo.agents.ref(agentId).refresh();
      const status = result?.agent.status;
      return status === "running" || status === "initializing";
    } catch {
      return false;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.paseo) return;
    this.ticking = true;
    try {
      const state = await this.settings.read();
      if (state.status !== "ready") return;
      const runs = await readRuns();
      let changed = false;
      const now = new Date();
      for (const bot of state.values.bots) {
        if (bot.archived || bot.hostId) continue;
        for (const routine of bot.routines) {
          const run = runs[routine.id] ?? EMPTY;
          const decision = decide(routine, run.lastRunAt, now);
          if (decision.action === "wait") continue;
          changed = true;
          const lastRunAt = now.toISOString();
          if (decision.action === "skip-missed") {
            runs[routine.id] = { ...run, lastRunAt, lastStatus: "skipped-missed", lastError: null };
          } else if (await this.busy(run.lastAgentId)) {
            // OpenMausBot's default overlap policy: skip while the previous run is still working.
            runs[routine.id] = { ...run, lastRunAt, lastStatus: "skipped-busy", lastError: null };
          } else {
            try {
              const agentId = await this.start(bot, routine, state.values.library ?? EMPTY_LIBRARY);
              runs[routine.id] = { lastRunAt, lastStatus: "started", lastError: null, lastAgentId: agentId };
            } catch (error) {
              runs[routine.id] = { ...run, lastRunAt, lastStatus: "failed", lastError: error instanceof Error ? error.message : String(error) };
            }
          }
        }
      }
      if (changed) await writeRuns(runs);
    } catch (error) {
      console.error("paseo-bot: routine tick failed", error);
    } finally {
      this.ticking = false;
    }
  }
}
