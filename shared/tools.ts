import { botToolName } from "./bot-tools";
import { toolCallName } from "./tool-name";

// Tool call presentation, ported from Paseo: labels and summaries from
// protocol/src/tool-call-display.ts (buildToolCallDisplayModel), icons from
// app/src/utils/tool-call-icon-name.ts, detail state from
// app/src/utils/tool-call-detail-state.ts, task lists and diffs from
// app/src/utils/tool-call-parsers.ts.

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: string;
      content?: string;
      filePaths?: string[];
      webResults?: { title: string; url: string }[];
      annotations?: string[];
    }
  | { type: "fetch"; url: string; prompt?: string; result?: string; code?: number; codeText?: string }
  | { type: "worktree_setup"; worktreePath: string; branchName: string; log: string }
  | { type: "sub_agent"; subAgentType?: string; description?: string; childSessionId?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string; icon?: string }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";

export interface ToolCallDisplayInput {
  name: string;
  status: ToolCallStatus;
  error: unknown;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
  cwd?: string;
}

export interface ToolCallDisplayModel {
  displayName: string;
  summary?: string;
  errorText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPaseoTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (/(^|[^a-z0-9])speak$/.test(normalized) || normalized === "speak") return false;
  if (normalized.includes("__")) {
    const segments = normalized.split("__").filter((segment) => segment.length > 0);
    return segments.length >= 3 && segments[0] === "mcp" && (segments[1] === "paseo" || segments[1]!.startsWith("paseo_"));
  }
  if (normalized.includes(".")) {
    const first = normalized.split(".")[0]!;
    return first === "paseo" || first.startsWith("paseo_");
  }
  return false;
}

function paseoLeafName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!isPaseoTool(normalized)) return null;
  if (normalized.includes("__")) return normalized.split("__").filter(Boolean).slice(2).join("__");
  return normalized.split(".").slice(1).join(".");
}

/** A tool's name as people read it: Paseo's and this plugin's tools get plain names, others stay as they are. */
export function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  // Paseo's own tools and this plugin's read as plain names ("Create agent", "Search chats").
  const leaf = paseoLeafName(trimmed) ?? botToolName(trimmed);
  if (leaf) return humanizeToolName(leaf);
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) return trimmed;
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

function stripCwdPrefix(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith(`${normalizedCwd}/`)) return normalizedPath.slice(normalizedCwd.length + 1);
  if (normalizedPath === normalizedCwd) return ".";
  return filePath;
}

function formatErrorText(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.content === "string") return error.content;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function canonicalDisplay(input: ToolCallDisplayInput): { displayName?: string; summary?: string } {
  const detail = input.detail;
  switch (detail.type) {
    case "shell":
      return { displayName: "Shell", summary: detail.command };
    case "read":
      return { displayName: "Read", summary: stripCwdPrefix(detail.filePath, input.cwd) };
    case "edit":
      return { displayName: "Edit", summary: stripCwdPrefix(detail.filePath, input.cwd) };
    case "write":
      return { displayName: "Write", summary: stripCwdPrefix(detail.filePath, input.cwd) };
    case "search":
      return { displayName: "Search", summary: detail.query };
    case "fetch":
      return { displayName: "Fetch", summary: detail.url };
    case "worktree_setup":
      return { displayName: "Worktree setup", summary: detail.branchName };
    case "sub_agent":
      return { displayName: readString(detail.subAgentType) ?? "Task", summary: readString(detail.description) };
    case "plain_text":
      return { summary: detail.label };
    case "plan":
      return { displayName: "Plan" };
    default:
      return {};
  }
}

function unknownDetailOverride(input: ToolCallDisplayInput): { displayName?: string; summary?: string } {
  const lower = input.name.trim().toLowerCase();
  if (input.detail.type === "unknown" && lower === "task") {
    return { displayName: "Task", summary: isRecord(input.metadata) ? readString(input.metadata.subAgentActivity) : undefined };
  }
  if (input.detail.type === "unknown" && lower === "thinking") return { displayName: "Thinking" };
  if (lower === "terminal") {
    return { displayName: "Terminal", summary: input.detail.type === "plain_text" ? readString(input.detail.label) : undefined };
  }
  return {};
}

/** Paseo's buildToolCallDisplayModel: "Shell" + command, "Read" + path, "Search" + query… */
export function buildToolCallDisplayModel(input: ToolCallDisplayInput): ToolCallDisplayModel {
  const canonical = canonicalDisplay(input);
  const override = unknownDetailOverride(input);
  const displayName = override.displayName ?? canonical.displayName ?? humanizeToolName(toolCallName(input));
  const summary = override.summary ?? canonical.summary;
  const errorText = input.status === "failed" ? formatErrorText(input.error) : undefined;
  return { displayName, ...(summary ? { summary } : {}), ...(errorText ? { errorText } : {}) };
}

// ---------------------------------------------------------------- icons

const DETAIL_ICONS: Record<ToolCallDetail["type"], string> = {
  shell: "SquareTerminal",
  read: "Eye",
  edit: "Pencil",
  write: "Pencil",
  search: "Search",
  fetch: "Search",
  worktree_setup: "SquareTerminal",
  sub_agent: "Bot",
  plain_text: "Wrench",
  plan: "Brain",
  unknown: "Wrench",
};

/** "square_terminal" → "SquareTerminal": Paseo's icon ids are snake-cased Lucide names. */
function lucideName(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Lucide icon for a tool call (Paseo's own tools get its logo; plugins can't draw it, so they get the wrench). */
export function toolIcon(name: string, detail?: { type: string; icon?: string }): string {
  const lower = name.trim().toLowerCase();
  if (detail?.type === "plain_text" && detail.icon) return lucideName(detail.icon);
  if (lower === "thinking" && (!detail || detail.type === "unknown")) return "Brain";
  if (lower === "speak") return "MicVocal";
  if (isPaseoTool(lower)) return "Wrench";
  if (lower === "task") return "Bot";
  return (detail && DETAIL_ICONS[detail.type as ToolCallDetail["type"]]) || "Wrench";
}

/** Tool label as Paseo's timeline shows it when there's no detail to go on. */
export function toolLabel(name: string): string {
  return humanizeToolName(name);
}

// ---------------------------------------------------------------- detail state

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return true;
}

export function hasMeaningfulToolCallDetail(detail: ToolCallDetail | undefined): boolean {
  if (!detail) return false;
  switch (detail.type) {
    case "shell":
      return true;
    case "read":
    case "write":
      return Boolean(detail.filePath || detail.content);
    case "edit":
      return Boolean(detail.filePath || detail.unifiedDiff || detail.oldString || detail.newString);
    case "search":
      return Boolean(detail.query.trim() || detail.content || detail.filePaths?.length || detail.webResults?.length || detail.annotations?.length);
    case "fetch":
      return Boolean(detail.url || detail.result || detail.codeText);
    case "worktree_setup":
      return Boolean(detail.branchName || detail.worktreePath || detail.log);
    case "sub_agent":
      return Boolean(detail.subAgentType || detail.description || detail.log);
    case "plain_text":
      return Boolean(detail.label || detail.text);
    case "plan":
      return detail.text.trim().length > 0;
    case "unknown":
      return hasMeaningfulValue(detail.input) || hasMeaningfulValue(detail.output);
  }
}

export interface ToolCallPresentation extends ToolCallDisplayModel {
  icon: string;
  isLoadingDetails: boolean;
  canOpenDetails: boolean;
  isPlan: boolean;
  planOutcome?: PlanOutcome;
}

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

/** Paseo's buildToolCallPresentation (tool-calls/presentation.ts). */
export function buildToolCallPresentation(input: ToolCallDisplayInput): ToolCallPresentation {
  const model = buildToolCallDisplayModel(input);
  const running = input.status === "running";
  const isLoadingDetails = running && input.error == null && !hasMeaningfulToolCallDetail(input.detail);
  const hasDetails = Boolean(input.error) || hasMeaningfulToolCallDetail(input.detail);
  let planOutcome: PlanOutcome | undefined;
  if (input.detail.type === "plan") {
    if (input.status === "canceled") planOutcome = "canceled";
    else if (input.metadata?.approved === false) planOutcome = "rejected";
    else if (input.metadata?.approved === true) planOutcome = "approved";
    else if (running) planOutcome = "pending";
  }
  return {
    ...model,
    icon: toolIcon(input.name, input.detail),
    isLoadingDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    isPlan: input.detail.type === "plan",
    ...(planOutcome ? { planOutcome } : {}),
  };
}

/** Approval UI owns pending plans; Paseo hides these tools from the stream (tool-calls/detail-level/projection.ts). */
export function isHiddenToolCall(name: string, status: string): boolean {
  return name === "ExitPlanMode" || (name === "plan_approval" && status === "running");
}

// ---------------------------------------------------------------- task lists

export interface TaskEntry {
  text: string;
  completed: boolean;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
  id?: string;
}

function normalizeTaskToolName(name: string): string {
  return name.trim().replace(/[.\s-]+/g, "_").toLowerCase();
}

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** Claude's TodoWrite and Codex's update_plan render as task lists (tool-call-parsers.ts). */
export function extractTaskEntriesFromToolCall(name: string, input: unknown): TaskEntry[] | null {
  const normalized = normalizeTaskToolName(name);
  if (normalized === "todowrite" || normalized === "todo_write") {
    if (!isRecord(input) || !Array.isArray(input.todos)) return null;
    const tasks: TaskEntry[] = [];
    for (const todo of input.todos) {
      if (!isRecord(todo) || typeof todo.content !== "string" || typeof todo.status !== "string" || !TASK_STATUSES.has(todo.status)) return null;
      const text = (typeof todo.activeForm === "string" ? todo.activeForm.trim() : "") || todo.content.trim();
      tasks.push({ text: text.length ? text : todo.content, completed: todo.status === "completed" });
    }
    return tasks;
  }
  if (normalized === "update_plan") {
    if (!isRecord(input) || !Array.isArray(input.plan)) return null;
    const tasks: TaskEntry[] = [];
    for (const entry of input.plan) {
      if (!isRecord(entry) || typeof entry.step !== "string") return null;
      const status = typeof entry.status === "string" && TASK_STATUSES.has(entry.status) ? entry.status : "pending";
      const text = entry.step.trim();
      if (text) tasks.push({ text, completed: status === "completed" });
    }
    return tasks;
  }
  return null;
}

/** Claude's TaskCreate/TaskUpdate/TaskList calls are hidden; the track shows them (types/stream.ts). */
export function isHiddenTaskTool(name: string, provider: string): boolean {
  if (provider !== "claude") return false;
  const normalized = normalizeTaskToolName(name);
  return normalized === "taskcreate" || normalized === "taskupdate" || normalized === "tasklist";
}

export type TaskActivity = { type: "created"; count: number } | { type: "added" | "started" | "completed"; task: string };

export function taskStatus(task: TaskEntry): "pending" | "in_progress" | "completed" {
  if (task.completed || task.status === "completed") return "completed";
  return task.status === "in_progress" ? "in_progress" : "pending";
}

/** What changed between two task list snapshots (types/stream.ts deriveTaskActivities). */
export function deriveTaskActivities(previous: readonly TaskEntry[], current: readonly TaskEntry[]): TaskActivity[] {
  if (previous.length === 0) return current.length > 0 ? [{ type: "created", count: current.length }] : [];
  const key = (task: TaskEntry, index: number) => task.id ?? `${index}:${task.text}`;
  const before = new Map(previous.map((task, index) => [key(task, index), task]));
  const activities: TaskActivity[] = [];
  current.forEach((task, index) => {
    const prior = before.get(key(task, index));
    if (!prior) {
      activities.push({ type: "added", task: task.text });
      return;
    }
    const was = taskStatus(prior);
    const now = taskStatus(task);
    if (was === now) return;
    if (now === "completed") activities.push({ type: "completed", task: task.text });
    else if (now === "in_progress") activities.push({ type: "started", task: task.text });
  });
  return activities;
}

// ---------------------------------------------------------------- diffs

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  segments?: DiffSegment[];
}

function splitLines(text: string): string[] {
  return text ? text.replace(/\r\n/g, "\n").split("\n") : [];
}

function splitWords(text: string): string[] {
  return text.match(/\w+|[^\w]+/g) ?? [];
}

/** Longest-common-subsequence lengths: table[i][j] covers a[i..] and b[j..]. */
export function lcsTable<T>(a: readonly T[], b: readonly T[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

function wordDiff(oldLine: string, newLine: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const a = splitWords(oldLine);
  const b = splitWords(newLine);
  const table = lcsTable(a, b);
  const inA = new Set<number>();
  const inB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA.add(i++);
      inB.add(j++);
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  const build = (words: string[], kept: Set<number>) => {
    const segments: DiffSegment[] = [];
    words.forEach((word, index) => {
      const changed = !kept.has(index);
      const last = segments[segments.length - 1];
      if (last && last.changed === changed) last.text += word;
      else segments.push({ text: word, changed });
    });
    return segments;
  };
  return { oldSegments: build(a, inA), newSegments: build(b, inB) };
}

/** Line diff of an edit's old and new strings, with word-level segments on replaced lines. */
export function buildLineDiff(original: string, updated: string): DiffLine[] {
  const a = splitLines(original);
  const b = splitLines(updated);
  if (a.length === 0 && b.length === 0) return [];
  // Large edits skip the quadratic diff and show removal then addition.
  if (a.length * b.length > 250_000) {
    return [...a.map((line) => ({ type: "remove" as const, content: `-${line}` })), ...b.map((line) => ({ type: "add" as const, content: `+${line}` }))];
  }
  const table = lcsTable(a, b);
  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      diff.push({ type: "context", content: ` ${a[i]}` });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) diff.push({ type: "remove", content: `-${a[i++]}` });
    else diff.push({ type: "add", content: `+${b[j++]}` });
  }
  while (i < a.length) diff.push({ type: "remove", content: `-${a[i++]}` });
  while (j < b.length) diff.push({ type: "add", content: `+${b[j++]}` });
  for (let index = 0; index < diff.length - 1; index++) {
    const current = diff[index]!;
    const next = diff[index + 1]!;
    if (current.type === "remove" && next.type === "add") {
      const { oldSegments, newSegments } = wordDiff(current.content.slice(1), next.content.slice(1));
      current.segments = oldSegments;
      next.segments = newSegments;
    }
  }
  return diff;
}

export function parseUnifiedDiff(text?: string): DiffLine[] {
  const diff: DiffLine[] = [];
  for (const line of splitLines(text ?? "")) {
    if (!line.length) diff.push({ type: "context", content: line });
    else if (line.startsWith("@@")) diff.push({ type: "header", content: line });
    else if (line.startsWith("+")) {
      if (!line.startsWith("+++")) diff.push({ type: "add", content: line });
    } else if (line.startsWith("-")) {
      if (!line.startsWith("---")) diff.push({ type: "remove", content: line });
    } else if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    else if (line.startsWith("\\ No newline")) diff.push({ type: "header", content: line });
    else diff.push({ type: "context", content: line });
  }
  return diff;
}
