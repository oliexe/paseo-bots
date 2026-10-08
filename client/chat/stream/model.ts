// Pure stream model: timeline entries → display rows → layout (gaps, turn
// footers, assistant padding). Mirrors Paseo's agent-stream/layout.ts,
// agent-stream/spacing.ts, agent-stream/turn-membership.ts and
// timeline/turn-time.ts. No React or React Native here, so it's unit tested.

import {
  deriveTaskActivities,
  extractTaskEntriesFromToolCall,
  isHiddenTaskTool,
  isHiddenToolCall,
  taskStatus,
  type TaskActivity,
  type TaskEntry,
  type ToolCallDetail,
  type ToolCallStatus,
} from "../../../shared/tools";
import { ROUTINE_RUN_CARD, RoutineRunCardSchema, type RoutineRunCard } from "../../../shared/rpc";
import { toolCallName } from "../../../shared/tool-name";
import { PLUGIN_ID } from "../../../shared/version";

/** The fields of a projected timeline entry the stream reads. */
export interface StreamEntry {
  provider: string;
  item: { type: string; [key: string]: unknown };
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}

interface RowBase {
  /** Stable across streaming: the entry's first seq, or the tool call id. */
  key: string;
  turnId?: string;
  timestamp: number;
}

export type StreamRow =
  | (RowBase & { kind: "user"; text: string; messageId?: string; clientMessageId?: string })
  | (RowBase & { kind: "assistant"; text: string; phase: "streaming" | "complete" })
  | (RowBase & { kind: "thought"; text: string; loading: boolean })
  | (RowBase & {
      kind: "tool";
      name: string;
      status: ToolCallStatus;
      error: unknown;
      detail: ToolCallDetail;
      metadata?: Record<string, unknown>;
    })
  | (RowBase & { kind: "speak"; text: string })
  | (RowBase & { kind: "todo"; items: TaskEntry[]; activity: TaskActivity })
  | (RowBase & { kind: "notification"; level: "info" | "warning" | "error"; message: string })
  | (RowBase & { kind: "compaction"; status: "loading" | "completed"; trigger?: "auto" | "manual"; preTokens?: number })
  | (RowBase & { kind: "routine-run"; card: RoutineRunCard });

export interface TurnFooterInfo {
  /** Key of the assistant row the footer belongs to. */
  key: string;
  /** The response's assistant text, for the copy button. */
  copy: string;
  completedAt: number | null;
  durationMs: number | null;
}

export interface StreamLayoutItem {
  row: StreamRow;
  gapBelow: number;
  /** Assistant rows drop their bottom padding when a footer follows. */
  compactBottom: boolean;
  footer: TurnFooterInfo | null;
}

export interface StreamLayout {
  items: StreamLayoutItem[];
  /** Footer of the latest response, rendered after the list when no turn is running. */
  auxiliaryFooter: TurnFooterInfo | null;
}

const EMPTY: never[] = [];

function toTime(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function toolStatus(value: unknown): ToolCallStatus {
  return value === "running" || value === "failed" || value === "canceled" ? value : "completed";
}

// ---------------------------------------------------------------- rows

/**
 * One row per visible timeline item. Tool calls hidden by Paseo (plan approval,
 * Claude's task tools) are dropped; task lists become per-change rows.
 */
export function buildRows(entries: readonly StreamEntry[], running: boolean): StreamRow[] {
  const rows: StreamRow[] = [];
  let lastTodo: Extract<StreamRow, { kind: "todo" }> | null = null;

  const appendTodo = (entry: StreamEntry, items: TaskEntry[]) => {
    const timestamp = toTime(entry.timestamp);
    const activities = deriveTaskActivities(lastTodo?.items ?? EMPTY, items);
    if (activities.length === 0) {
      if (lastTodo) {
        lastTodo.items = items;
        lastTodo.timestamp = timestamp;
      }
      return;
    }
    const tail = rows[rows.length - 1];
    if (
      activities.length === 1 &&
      activities[0]!.type === "added" &&
      tail?.kind === "todo" &&
      tail.activity.type === "created" &&
      items.every((task) => taskStatus(task) === "pending")
    ) {
      tail.items = items;
      tail.activity = { type: "created", count: items.length };
      tail.timestamp = timestamp;
      lastTodo = tail;
      return;
    }
    activities.forEach((activity, index) => {
      const row: Extract<StreamRow, { kind: "todo" }> = { key: `${entry.seqStart}:todo:${index}`, kind: "todo", turnId: entry.turnId, timestamp, items, activity };
      rows.push(row);
      lastTodo = row;
    });
  };

  entries.forEach((entry, index) => {
    const item = entry.item;
    const base = { key: `e${entry.seqStart}`, turnId: entry.turnId, timestamp: toTime(entry.timestamp) };
    const isLast = index === entries.length - 1;
    switch (item.type) {
      case "user_message":
        rows.push({
          ...base,
          kind: "user",
          text: String(item.text ?? ""),
          ...(typeof item.messageId === "string" ? { messageId: item.messageId } : {}),
          ...(typeof item.clientMessageId === "string" ? { clientMessageId: item.clientMessageId } : {}),
        });
        break;
      case "assistant_message":
        rows.push({ ...base, kind: "assistant", text: String(item.text ?? ""), phase: running && isLast ? "streaming" : "complete" });
        break;
      case "reasoning": {
        const text = String(item.text ?? "");
        rows.push({ ...base, kind: "thought", text, loading: running && isLast });
        break;
      }
      case "tool_call": {
        const name = toolCallName({ name: String(item.name ?? ""), metadata: item.metadata });
        const status = toolStatus(item.status);
        const detail = (item.detail ?? { type: "unknown", input: null, output: null }) as ToolCallDetail;
        if (isHiddenToolCall(name, status) || isHiddenTaskTool(name, entry.provider)) break;
        const tasks = extractTaskEntriesFromToolCall(name, detail.type === "unknown" ? detail.input : null);
        if (tasks) {
          appendTodo(entry, tasks);
          break;
        }
        const key = typeof item.callId === "string" && item.callId ? `tool:${item.callId}` : base.key;
        if (name === "speak" && detail.type === "unknown" && typeof detail.input === "string" && detail.input.trim()) {
          rows.push({ ...base, key, kind: "speak", text: detail.input });
          break;
        }
        rows.push({
          ...base,
          key,
          kind: "tool",
          name,
          status,
          error: item.error ?? null,
          detail,
          ...(item.metadata && typeof item.metadata === "object" ? { metadata: item.metadata as Record<string, unknown> } : {}),
        });
        break;
      }
      case "todo": {
        const items = Array.isArray(item.items) ? (item.items as TaskEntry[]) : [];
        appendTodo(entry, items);
        break;
      }
      case "error":
        rows.push({ ...base, kind: "notification", level: "error", message: String(item.message ?? "") });
        break;
      case "notification": {
        const level = item.level === "warning" || item.level === "error" ? item.level : "info";
        rows.push({ ...base, kind: "notification", level, message: String(item.message ?? "") });
        break;
      }
      case "compaction":
        rows.push({
          ...base,
          kind: "compaction",
          status: item.status === "loading" ? "loading" : "completed",
          ...(item.trigger === "auto" || item.trigger === "manual" ? { trigger: item.trigger } : {}),
          ...(typeof item.preTokens === "number" ? { preTokens: item.preTokens } : {}),
        });
        break;
      case "plugin": {
        // This plugin's routine result cards; other plugins' items belong to their renderers.
        if (item.pluginId !== PLUGIN_ID || item.kind !== ROUTINE_RUN_CARD.kind) break;
        const card = RoutineRunCardSchema.safeParse(item.data);
        if (card.success) rows.push({ ...base, key: `plugin:${String(item.id ?? entry.seqStart)}`, kind: "routine-run", card: card.data });
        break;
      }
      default:
        break;
    }
  });
  // FlatList keys must be unique even if a provider reuses a call id.
  const seen = new Set<string>();
  for (const row of rows) {
    let key = row.key;
    for (let n = 1; seen.has(key); n++) key = `${row.key}#${n}`;
    row.key = key;
    seen.add(key);
  }
  return rows;
}

// ---------------------------------------------------------------- turns

type Category = "user" | "assistant" | "tool" | "other";

function category(row: StreamRow | null | undefined): Category | null {
  if (!row) return null;
  switch (row.kind) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
    case "thought":
    case "todo":
    case "speak":
      return "tool";
    default:
      return "other";
  }
}

/** turn-membership.ts continuesTurn: canonical turn ids first, else a user message starts a turn. */
/** Routine result cards arrive between turns and belong to none. */
const standsAlone = (row: StreamRow) => row.kind === "routine-run";

function continuesTurn(previous: StreamRow | null, next: StreamRow | null): boolean {
  if (!previous || !next || standsAlone(previous) || standsAlone(next)) return false;
  if (previous.turnId !== undefined && next.turnId !== undefined) return previous.turnId === next.turnId;
  return next.kind !== "user";
}

function continuesResponse(previous: StreamRow | null, next: StreamRow | null): boolean {
  if (!previous || !next || standsAlone(previous) || standsAlone(next)) return false;
  return continuesTurn(previous, next) || next.kind !== "user";
}

function isResponseBoundary(previous: StreamRow | null, next: StreamRow | null): boolean {
  return previous !== null && next !== null && !continuesResponse(previous, next);
}

/** spacing.ts getGapBetweenStreamItems. */
export function gapBetween(row: StreamRow | null, below: StreamRow | null): number {
  const a = category(row);
  const b = category(below);
  if (!a || !b) return 0;
  if (a === "user" && b === "user") return 4;
  if (a === "user" && b === "assistant") return 0;
  if (a === "tool" && b === "tool") return 0;
  if (a === "user" && b === "tool") return 16;
  if (a === "assistant" && b === "tool") return 4;
  if (a === "tool" && b === "assistant") return 4;
  return 16;
}

interface TurnTiming {
  completedAt: number;
  durationMs: number | null;
}

/** timeline/turn-time.ts deriveStreamTurnTiming, keyed by assistant row key. */
export function deriveTurnTiming(rows: readonly StreamRow[], running: boolean): Map<string, TurnTiming> {
  const timing = new Map<string, TurnTiming>();
  let userAt: number | null = null;
  let lastAt: number | null = null;
  let assistants: string[] = [];
  let previous: StreamRow | null = null;
  const flush = () => {
    if (lastAt === null || assistants.length === 0) return;
    const value = { completedAt: lastAt, durationMs: userAt !== null ? Math.max(0, lastAt - userAt) : null };
    for (const key of assistants) timing.set(key, value);
  };
  for (const row of rows) {
    if (previous === null || !continuesTurn(previous, row)) {
      flush();
      userAt = row.kind === "user" ? row.timestamp : null;
      lastAt = null;
      assistants = [];
    }
    lastAt = row.timestamp;
    if (row.kind === "assistant") assistants.push(row.key);
    previous = row;
  }
  if (!running) flush();
  return timing;
}

/** The newest assistant row of the response that ends at `index`, walking back to its prompt. */
function latestAssistantInResponse(rows: readonly StreamRow[], index: number): number | null {
  let later: StreamRow | null = null;
  for (let i = index; i >= 0; i--) {
    const row = rows[i]!;
    if (later && !continuesResponse(row, later)) return null;
    if (row.kind === "assistant") return i;
    later = row;
  }
  return null;
}

/** strategy.ts collectAssistantResponseContent. */
function responseText(rows: readonly StreamRow[], index: number): string {
  const messages: string[] = [];
  let later: StreamRow | null = null;
  for (let i = index; i >= 0; i--) {
    const row = rows[i]!;
    if (later && !continuesResponse(row, later)) break;
    if (row.kind === "assistant") messages.push(row.text);
    later = row;
  }
  return messages.reverse().join("\n\n");
}

function footerFor(rows: readonly StreamRow[], assistantIndex: number, timing: Map<string, TurnTiming>): TurnFooterInfo {
  const row = rows[assistantIndex]!;
  const time = timing.get(row.key);
  return { key: row.key, copy: responseText(rows, assistantIndex), completedAt: time?.completedAt ?? null, durationMs: time?.durationMs ?? null };
}

/** layout.ts layoutStream for a forward (oldest-first) list. */
export function layoutStream(rows: readonly StreamRow[], running: boolean): StreamLayout {
  const timing = deriveTurnTiming(rows, running);
  let auxiliaryFooter: TurnFooterInfo | null = null;
  if (!running && rows.length > 0) {
    const assistant = latestAssistantInResponse(rows, rows.length - 1);
    if (assistant !== null) auxiliaryFooter = footerFor(rows, assistant, timing);
  }
  const hasAuxiliaryFooter = running || auxiliaryFooter !== null;
  const items = rows.map((row, index): StreamLayoutItem => {
    const below = rows[index + 1] ?? null;
    let footer: TurnFooterInfo | null = null;
    if (row.kind !== "user" && isResponseBoundary(row, below)) {
      const assistant = latestAssistantInResponse(rows, index);
      if (assistant !== null && rows[assistant]!.key !== auxiliaryFooter?.key) footer = footerFor(rows, assistant, timing);
    }
    const compactBottom = row.kind === "assistant" && (footer !== null || (hasAuxiliaryFooter && below === null));
    return { row, gapBelow: footer ? 0 : gapBetween(row, below), compactBottom, footer };
  });
  return { items, auxiliaryFooter };
}

// ---------------------------------------------------------------- identity

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function shallowEqual(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => sameValue(left[key], right[key]));
}

function sameFooter(a: TurnFooterInfo | null, b: TurnFooterInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.key === b.key && a.copy === b.copy && a.completedAt === b.completedAt && a.durationMs === b.durationMs;
}

/**
 * Keeps the previous object for every row and layout item whose content didn't
 * change, so memoised rows skip rendering while another row streams.
 */
export function retainLayout(previous: StreamLayout | null, next: StreamLayout): StreamLayout {
  if (!previous) return next;
  const byKey = new Map(previous.items.map((item) => [item.row.key, item]));
  let changed = previous.items.length !== next.items.length;
  const items = next.items.map((item, index) => {
    const old = byKey.get(item.row.key);
    if (!old) {
      changed = true;
      return item;
    }
    const row = old.row === item.row || (old.row.kind === item.row.kind && shallowEqual(old.row, item.row)) ? old.row : item.row;
    const same = row === old.row && old.gapBelow === item.gapBelow && old.compactBottom === item.compactBottom && sameFooter(old.footer, item.footer);
    const kept = same ? old : { ...item, row };
    if (kept !== previous.items[index]) changed = true;
    return kept;
  });
  const auxiliaryFooter = sameFooter(previous.auxiliaryFooter, next.auxiliaryFooter) ? previous.auxiliaryFooter : next.auxiliaryFooter;
  if (!changed && auxiliaryFooter === previous.auxiliaryFooter) return previous;
  return { items: changed ? items : previous.items, auxiliaryFooter };
}

// ---------------------------------------------------------------- timeline merge

export interface MergeableEntry {
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges?: readonly { startSeq: number; endSeq: number }[];
}

function sameEntry(a: MergeableEntry, b: MergeableEntry): boolean {
  if (a.seqStart !== b.seqStart || a.seqEnd !== b.seqEnd) return false;
  return JSON.stringify(a.sourceSeqRanges ?? null) === JSON.stringify(b.sourceSeqRanges ?? null);
}

/**
 * Merges a fetched page into the entries we hold, by the projected entry's
 * first seq: a re-sent entry (a message still streaming, a tool that finished)
 * replaces the old one, unchanged ones keep their identity.
 */
/** Rows whose text contains `needle` (lower-case), by index: what the user and the bot wrote. */
export function findRows(items: readonly StreamLayoutItem[], needle: string): number[] {
  if (!needle) return [];
  return items.flatMap((item, index) => {
    const row = item.row;
    const text = row.kind === "user" || row.kind === "assistant" || row.kind === "speak" ? row.text : "";
    return text.toLowerCase().includes(needle) ? [index] : [];
  });
}

export function mergeEntries<T extends MergeableEntry>(current: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return current as T[];
  const bySeq = new Map<number, T>();
  for (const entry of current) bySeq.set(entry.seqStart, entry);
  let changed = false;
  for (const entry of incoming) {
    const existing = bySeq.get(entry.seqStart);
    if (existing && sameEntry(existing, entry)) continue;
    bySeq.set(entry.seqStart, entry);
    changed = true;
  }
  if (!changed) return current as T[];
  return [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);
}
