import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { redactSecrets } from "../shared/activity";
import { pluginDataPath } from "./bot-home";

// OpenMausBot's command allowlist: an exact command in an exact folder that a
// bot may run without asking, saved from the command's approval card. Rules
// live on this host apart from the bots' settings, so they're never exported.

const MAX_COMMAND_BYTES = 16_384;
const MAX_RULES_PER_BOT = 200;

export interface CommandRule {
  id: string;
  command: string;
  cwd: string;
}

type StoredRule = CommandRule & { botId: string };

function storePath(): string {
  return join(pluginDataPath(), "commands.json");
}

/** Throws a message the person can act on when a rule can't be saved. */
export function validateRule(command: string, cwd: string): void {
  if (!command.trim() || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || /[\p{Cc}]/u.test(command.replace(/[\t\r\n]/g, ""))) {
    throw new Error("The command must be text of at most 16 KB.");
  }
  if (redactSecrets(command) !== command) throw new Error("Commands with credentials in them can't be saved. Use an environment variable instead.");
  if (!isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw new Error("The folder must be an absolute path.");
}

export class CommandAllowlist {
  private queue: Promise<unknown> = Promise.resolve();

  private async load(): Promise<StoredRule[]> {
    try {
      const saved = JSON.parse(await readFile(storePath(), "utf8")) as { rules?: StoredRule[] };
      return Array.isArray(saved.rules) ? saved.rules : [];
    } catch {
      return [];
    }
  }

  private change<T>(edit: (rules: StoredRule[]) => { rules: StoredRule[]; result: T }): Promise<T> {
    const run = async () => {
      const { rules, result } = edit(await this.load());
      await mkdir(pluginDataPath(), { recursive: true });
      await writeFile(storePath(), JSON.stringify({ version: 1, rules }, null, 2), { encoding: "utf8", mode: 0o600 });
      return result;
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  async list(botId: string): Promise<CommandRule[]> {
    return (await this.load()).filter((rule) => rule.botId === botId).map(({ botId: _botId, ...rule }) => rule);
  }

  async add(botId: string, command: string, cwd: string): Promise<CommandRule> {
    validateRule(command, cwd);
    return this.change((rules) => {
      const mine = rules.filter((rule) => rule.botId === botId);
      const same = mine.find((rule) => rule.command === command && rule.cwd === cwd);
      if (same) return { rules, result: { id: same.id, command, cwd } };
      if (mine.length >= MAX_RULES_PER_BOT) throw new Error(`A bot can have at most ${MAX_RULES_PER_BOT} allowed commands.`);
      const rule: CommandRule = { id: randomUUID(), command, cwd };
      return { rules: [...rules, { ...rule, botId }], result: rule };
    });
  }

  remove(botId: string, id: string): Promise<boolean> {
    return this.change((rules) => {
      const next = rules.filter((rule) => rule.botId !== botId || rule.id !== id);
      return { rules: next, result: next.length !== rules.length };
    });
  }

  /** Exact command and folder only: a longer command or another folder still asks. */
  async matches(botId: string, command: string, cwd: string): Promise<boolean> {
    return (await this.load()).some((rule) => rule.botId === botId && rule.command === command && rule.cwd === cwd);
  }
}
