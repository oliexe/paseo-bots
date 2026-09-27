import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../shared/activity";
import { lineDiff } from "../shared/diff";
import { pluginDataPath } from "./bot-home";
import { MAIN_MEMORY, memoryFilePath, memoryFolder } from "./memory";

// OpenMausBot's memory journal: every change to a bot's MEMORY.md and topic
// files, with the earlier text so it can be undone. Bots edit their memory with
// their own file tools, so their changes are found by comparing the files when
// a turn starts and ends. The journal lives outside the bots' folders so a bot
// can't rewrite its own history. The daily log is the app's own and isn't journaled.

const KEEP = 200;
const MAX_BEFORE_BYTES = 512 * 1024;

export interface JournalEntry {
  id: string;
  at: string;
  /** "MEMORY.md" or a topic file's name, as the memory RPCs name them. */
  file: string;
  actor: "bot" | "you";
  via: "chat" | "app" | "disk" | "undo";
  chat: { id: string; title: string } | null;
  kind: "created" | "edited" | "deleted";
  /** The text before the change; null for a new file or one too large to keep. */
  before: string | null;
  diff: string;
  added: number;
  removed: number;
}

type Snapshot = Map<string, string>;

function journalPath(botId: string): string {
  return join(pluginDataPath(), "journal", `${botId}.ndjson`);
}

/** MEMORY.md (when it exists) and every topic file, by name. */
async function snapshot(botId: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  const main = await readFile(memoryFilePath(botId, MAIN_MEMORY), "utf8").catch(() => null);
  if (main !== null) files.set(MAIN_MEMORY, main);
  const names = await readdir(join(memoryFolder(botId), "memory")).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const text = await readFile(memoryFilePath(botId, name), "utf8").catch(() => null);
    if (text !== null) files.set(name, text);
  }
  return files;
}

export class MemoryJournal {
  /** What each bot's memory looked like when the journal last checked. */
  private readonly seen = new Map<string, Snapshot>();
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Runs one change per bot at a time. */
  private serial<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(botId) ?? Promise.resolve()).then(work);
    this.queues.set(
      botId,
      next.catch(() => {}),
    );
    return next;
  }

  /** A turn is starting: anything that changed since the last look was done outside the app. */
  begin(botId: string): Promise<void> {
    return this.serial(botId, async () => {
      const current = await snapshot(botId);
      const previous = this.seen.get(botId);
      if (previous) await this.record(botId, previous, current, { actor: "you", via: "disk", chat: null });
      this.seen.set(botId, current);
    });
  }

  /** A turn ended: what changed during it was the bot's doing in that chat. */
  end(botId: string, chat: { id: string; title: string }): Promise<void> {
    return this.serial(botId, async () => {
      const current = await snapshot(botId);
      const previous = this.seen.get(botId);
      // After a restart there's nothing to compare with until the next turn.
      if (previous) await this.record(botId, previous, current, { actor: "bot", via: "chat", chat });
      this.seen.set(botId, current);
    });
  }

  /** The app is about to write or delete a memory file (null) for the person. */
  write(botId: string, file: string, text: string | null, via: "app" | "undo" = "app"): Promise<void> {
    return this.serial(botId, () => this.apply(botId, file, text, via));
  }

  private async apply(botId: string, file: string, text: string | null, via: "app" | "undo"): Promise<void> {
    const path = memoryFilePath(botId, file);
    const before = await readFile(path, "utf8").catch(() => null);
    if (text === null) await rm(path, { force: true });
    else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text, "utf8");
    }
    await this.append(botId, file, before, text, { actor: "you", via, chat: null });
    const seen = this.seen.get(botId);
    if (seen) {
      if (text === null) seen.delete(file);
      else seen.set(file, text);
    }
  }

  async list(botId: string, limit = 50): Promise<JournalEntry[]> {
    return (await this.load(botId)).reverse().slice(0, limit);
  }

  /** Puts a file back the way it was before an entry; the undo is journaled too. */
  undo(botId: string, id: string): Promise<void> {
    return this.serial(botId, async () => {
      const entry = (await this.load(botId)).find((candidate) => candidate.id === id);
      if (!entry) throw new Error("That change is no longer in the journal.");
      if (entry.kind !== "created" && entry.before === null) throw new Error("This change was too large to keep a copy of.");
      // Undoing a new topic file deletes it; MEMORY.md is emptied instead.
      const restore = entry.kind === "created" ? (entry.file === MAIN_MEMORY ? "" : null) : entry.before;
      await this.apply(botId, entry.file, restore, "undo");
    });
  }

  private async record(botId: string, previous: Snapshot, current: Snapshot, who: Pick<JournalEntry, "actor" | "via" | "chat">): Promise<void> {
    for (const file of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(file) ?? null;
      const after = current.get(file) ?? null;
      if (before !== after) await this.append(botId, file, before, after, who);
    }
  }

  private async append(botId: string, file: string, before: string | null, after: string | null, who: Pick<JournalEntry, "actor" | "via" | "chat">): Promise<void> {
    if (before === after) return;
    const { diff, added, removed } = lineDiff(redactSecrets(before ?? ""), redactSecrets(after ?? ""));
    const entry: JournalEntry = {
      id: `j-${randomBytes(5).toString("hex")}`,
      at: new Date().toISOString(),
      file,
      ...who,
      kind: before === null ? "created" : after === null ? "deleted" : "edited",
      before: before !== null && Buffer.byteLength(before, "utf8") <= MAX_BEFORE_BYTES ? before : null,
      diff,
      added,
      removed,
    };
    const entries = [...(await this.load(botId)), entry].slice(-KEEP);
    await mkdir(join(pluginDataPath(), "journal"), { recursive: true });
    await writeFile(journalPath(botId), entries.map((item) => JSON.stringify(item)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  }

  private async load(botId: string): Promise<JournalEntry[]> {
    const text = await readFile(journalPath(botId), "utf8").catch(() => "");
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn line from a crash; skip it.
      }
    }
    return entries;
  }
}
