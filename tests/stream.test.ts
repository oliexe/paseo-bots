import { describe, expect, it } from "vitest";
import { buildRows, deriveTurnTiming, findRows, gapBetween, layoutStream, mergeEntries, retainLayout, type StreamEntry, type StreamRow } from "../client/chat/stream/model";
import { proposalIdOf } from "../shared/proposals";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  parseQuestionFormQuestions,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "../client/chat/stream/question";
import {
  buildLineDiff,
  buildToolCallDisplayModel,
  buildToolCallPresentation,
  deriveTaskActivities,
  extractTaskEntriesFromToolCall,
  parseUnifiedDiff,
  toolIcon,
  toolLabel,
} from "../shared/tools";

let seq = 0;
function entry(item: StreamEntry["item"], options: { at?: number; turnId?: string; provider?: string; seqStart?: number } = {}): StreamEntry {
  const start = options.seqStart ?? ++seq;
  return {
    provider: options.provider ?? "claude",
    item,
    timestamp: new Date(options.at ?? 0).toISOString(),
    seqStart: start,
    seqEnd: start,
    ...(options.turnId ? { turnId: options.turnId } : {}),
  };
}
const user = (text: string, at = 0) => entry({ type: "user_message", text }, { at });
const assistant = (text: string, at = 0) => entry({ type: "assistant_message", text }, { at });
const tool = (name: string, detail: unknown, extra: Record<string, unknown> = {}, at = 0) =>
  entry({ type: "tool_call", callId: `call-${name}-${seq + 1}`, name, status: "completed", error: null, detail, ...extra }, { at });

describe("buildRows", () => {
  it("keys rows by first seq and tool call id so streaming never remounts them", () => {
    const rows = buildRows([user("hi"), assistant("hello"), tool("Bash", { type: "shell", command: "ls" })], true);
    expect(rows.map((row) => row.key)).toEqual([expect.stringMatching(/^e\d+$/), expect.stringMatching(/^e\d+$/), expect.stringMatching(/^tool:call-Bash-/)]);
    const streaming = buildRows([user("hi"), assistant("hel")], true);
    expect(streaming[1]).toMatchObject({ kind: "assistant", phase: "streaming" });
    expect(buildRows([user("hi"), assistant("hel")], false)[1]).toMatchObject({ phase: "complete" });
  });

  it("names an ACP provider's tool rows after the tool in their title, so proposals get their card", () => {
    const output = "Proposal p-0123456789: the user sees...";
    const [row] = buildRows([tool("other", { type: "unknown", input: {}, output }, { metadata: { kind: "other", title: "mcp__bots__propose_changes: Add a Researcher bot" } })], false);
    expect(row).toMatchObject({ kind: "tool", name: "mcp__bots__propose_changes" });
    expect(row?.kind === "tool" ? proposalIdOf(row) : null).toBe("p-0123456789");
  });

  it("hides ExitPlanMode, running plan approvals and Claude's task tools", () => {
    const rows = buildRows(
      [
        tool("ExitPlanMode", { type: "unknown", input: {}, output: null }),
        entry({ type: "tool_call", callId: "p", name: "plan_approval", status: "running", error: null, detail: { type: "plan", text: "x" } }),
        tool("TaskCreate", { type: "unknown", input: {}, output: null }),
        tool("Read", { type: "read", filePath: "/a" }),
      ],
      false,
    );
    expect(rows.map((row) => row.kind === "tool" && row.name)).toEqual(["Read"]);
  });

  it("marks only the last reasoning of a running turn as loading", () => {
    const rows = buildRows([entry({ type: "reasoning", text: "a" }), assistant("b"), entry({ type: "reasoning", text: "c" })], true);
    expect(rows.filter((row) => row.kind === "thought").map((row) => (row as Extract<StreamRow, { kind: "thought" }>).loading)).toEqual([false, true]);
  });

  it("turns TodoWrite updates into per-change task rows (status beyond done/not done is dropped, as in Paseo)", () => {
    const todos = (statuses: string[]) => ({ type: "unknown", input: { todos: statuses.map((status, i) => ({ content: `task ${i}`, status })) }, output: null });
    const rows = buildRows([tool("TodoWrite", todos(["pending", "pending"])), tool("TodoWrite", todos(["in_progress", "pending"])), tool("TodoWrite", todos(["completed", "in_progress"]))], false);
    expect(rows.map((row) => row.kind === "todo" && row.activity)).toEqual([
      { type: "created", count: 2 },
      { type: "completed", task: "task 0" },
    ]);
    const timeline = buildRows(
      [
        entry({ type: "todo", items: [{ text: "a", completed: false, status: "pending" }] }),
        entry({ type: "todo", items: [{ text: "a", completed: false, status: "in_progress" }] }),
      ],
      false,
    );
    expect(timeline.map((row) => row.kind === "todo" && row.activity)).toEqual([
      { type: "created", count: 1 },
      { type: "started", task: "a" },
    ]);
  });

  it("maps notices, errors, compaction and speak", () => {
    const rows = buildRows(
      [
        entry({ type: "error", message: "boom" }),
        entry({ type: "notification", level: "warning", message: "careful" }),
        entry({ type: "compaction", status: "completed", preTokens: 12_000 }),
        tool("speak", { type: "unknown", input: "Hello there", output: null }),
      ],
      false,
    );
    expect(rows.map((row) => row.kind)).toEqual(["notification", "notification", "compaction", "speak"]);
    expect(rows[0]).toMatchObject({ level: "error", message: "boom" });
  });

  it("keeps keys unique", () => {
    const a = tool("Read", { type: "read", filePath: "/a" });
    const b = { ...a, seqStart: a.seqStart + 100, seqEnd: a.seqEnd + 100 };
    const rows = buildRows([a, b], false);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});

describe("spacing", () => {
  const rows = buildRows([user("a"), user("b"), assistant("c"), tool("Bash", { type: "shell", command: "x" }), entry({ type: "todo", items: [{ text: "t", completed: false }] }), assistant("d"), entry({ type: "error", message: "e" })], false);
  it("follows Paseo's gaps", () => {
    expect(gapBetween(rows[0]!, rows[1]!)).toBe(4); // user → user
    expect(gapBetween(rows[1]!, rows[2]!)).toBe(0); // user → assistant
    expect(gapBetween(rows[2]!, rows[3]!)).toBe(4); // assistant → tool
    expect(gapBetween(rows[3]!, rows[4]!)).toBe(0); // tool → todo: one tool sequence
    expect(gapBetween(rows[4]!, rows[5]!)).toBe(4); // todo → assistant
    expect(gapBetween(rows[5]!, rows[6]!)).toBe(16); // default
    expect(gapBetween(rows[0]!, null)).toBe(0);
  });
});

describe("turn footers", () => {
  it("adds a footer only to responses with assistant text", () => {
    const rows = buildRows([user("q1", 0), tool("Bash", { type: "shell", command: "ls" }, {}, 1000), user("q2", 2000), assistant("a2", 5000)], false);
    const layout = layoutStream(rows, false);
    expect(layout.items.map((item) => item.footer?.key ?? null)).toEqual([null, null, null, null]);
    expect(layout.auxiliaryFooter).toMatchObject({ key: rows[3]!.key, copy: "a2", durationMs: 3000, completedAt: 5000 });
    expect(layout.items[3]!.compactBottom).toBe(true);
  });

  it("places completed footers at response boundaries with the response text", () => {
    const rows = buildRows([user("q1", 0), assistant("one", 1000), tool("Read", { type: "read", filePath: "/a" }, {}, 1500), assistant("two", 64_000), user("q2", 70_000), assistant("three", 71_000)], false);
    const layout = layoutStream(rows, false);
    const footer = layout.items[3]!.footer;
    expect(footer).toMatchObject({ key: rows[3]!.key, copy: "one\n\ntwo", durationMs: 64_000 });
    expect(layout.items[3]!.gapBelow).toBe(0);
    expect(layout.items[3]!.compactBottom).toBe(true);
    expect(layout.items[1]!.compactBottom).toBe(false);
  });

  it("shows no completed footer for the running turn", () => {
    const rows = buildRows([user("q", 0), assistant("partial", 10)], true);
    const layout = layoutStream(rows, true);
    expect(layout.auxiliaryFooter).toBeNull();
    expect(deriveTurnTiming(rows, true).size).toBe(0);
    expect(layout.items[1]!.compactBottom).toBe(true);
  });

  it("shows this plugin's routine run cards apart from the turn before them", () => {
    const card = { routineName: "Inbox", trigger: "manual", scheduledFor: new Date(60_000).toISOString(), status: "running", agentId: "a", output: null, error: null };
    const rows = buildRows(
      [
        user("q", 0),
        assistant("done", 8000),
        entry({ type: "plugin", pluginId: "paseo-bots", id: "run-1", kind: "routine-run", version: 1, data: card }, { at: 60_000 }),
        entry({ type: "plugin", pluginId: "other", id: "x", kind: "routine-run", version: 1, data: card }, { at: 61_000 }),
      ],
      false,
    );
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "routine-run"]);
    expect(rows[2]!.key).toBe("plugin:run-1");
    const layout = layoutStream(rows, false);
    expect(layout.auxiliaryFooter).toBeNull();
    expect(layout.items[1]!.footer).toMatchObject({ copy: "done", durationMs: 8000 });
  });

  it("uses canonical turn ids when present", () => {
    const rows: StreamRow[] = [
      { key: "a", kind: "user", text: "q", turnId: "t1", timestamp: 0 },
      { key: "b", kind: "assistant", text: "x", phase: "complete", turnId: "t1", timestamp: 1000 },
      { key: "c", kind: "assistant", text: "y", phase: "complete", turnId: "t2", timestamp: 5000 },
    ];
    const timing = deriveTurnTiming(rows, false);
    expect(timing.get("b")).toEqual({ completedAt: 1000, durationMs: 1000 });
    expect(timing.get("c")).toEqual({ completedAt: 5000, durationMs: null });
  });
});

describe("retainLayout", () => {
  it("keeps unchanged rows and items by identity", () => {
    const entries = [user("q"), assistant("partial")];
    const first = layoutStream(buildRows(entries, true), true);
    const grown = [entries[0]!, { ...entries[1]!, item: { type: "assistant_message", text: "partial and more" } }];
    const second = retainLayout(first, layoutStream(buildRows(grown, true), true));
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).not.toBe(first.items[1]);
    const third = retainLayout(second, layoutStream(buildRows(grown, true), true));
    expect(third).toBe(second);
  });
});

describe("mergeEntries", () => {
  it("replaces re-sent entries by first seq and keeps order", () => {
    const a = { seqStart: 1, seqEnd: 1, text: "a" };
    const b = { seqStart: 2, seqEnd: 3, text: "b" };
    const current = [a, b];
    const merged = mergeEntries(current, [{ seqStart: 2, seqEnd: 5, text: "bb" }, { seqStart: 6, seqEnd: 6, text: "c" }]);
    expect(merged.map((entry) => entry.text)).toEqual(["a", "bb", "c"]);
    expect(merged[0]).toBe(a);
    expect(mergeEntries(current, [{ seqStart: 2, seqEnd: 3, text: "b" }])).toBe(current);
    expect(mergeEntries(current, [{ seqStart: 0, seqEnd: 0, text: "older" }]).map((entry) => entry.text)).toEqual(["older", "a", "b"]);
  });
});

describe("tool display model", () => {
  it("matches Paseo's labels and summaries", () => {
    expect(buildToolCallDisplayModel({ name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } })).toEqual({ displayName: "Shell", summary: "npm test" });
    expect(buildToolCallDisplayModel({ name: "Read", status: "completed", error: null, detail: { type: "read", filePath: "/repo/src/a.ts" }, cwd: "/repo" })).toEqual({ displayName: "Read", summary: "src/a.ts" });
    expect(buildToolCallDisplayModel({ name: "Grep", status: "completed", error: null, detail: { type: "search", query: "foo" } })).toEqual({ displayName: "Search", summary: "foo" });
    expect(buildToolCallDisplayModel({ name: "Task", status: "running", error: null, detail: { type: "sub_agent", subAgentType: "Explore", description: "Find it", log: "" } })).toEqual({ displayName: "Explore", summary: "Find it" });
    expect(buildToolCallDisplayModel({ name: "mcp__paseo__list_workspaces", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } }).displayName).toBe("List workspaces");
    expect(buildToolCallDisplayModel({ name: "mcp__bots__search_chats", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } }).displayName).toBe("Search chats");
    expect(buildToolCallDisplayModel({ name: "mcp__other__search_chats", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } }).displayName).toBe("mcp__other__search_chats");
    const acp = { name: "other", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } } as const;
    expect(buildToolCallDisplayModel({ ...acp, metadata: { kind: "other", title: "mcp__bots__search_chats: invoices: march" } }).displayName).toBe("Search chats");
    expect(buildToolCallDisplayModel({ ...acp, metadata: { kind: "other", title: "Run the linter" } }).displayName).toBe("Other");
    expect(buildToolCallDisplayModel({ name: "thinking", status: "completed", error: null, detail: { type: "unknown", input: "x", output: null } }).displayName).toBe("Thinking");
    expect(buildToolCallDisplayModel({ name: "Bash", status: "failed", error: { content: "exit 1" }, detail: { type: "shell", command: "false" } }).errorText).toBe("exit 1");
  });

  it("keeps the old label and icon helpers", () => {
    expect(toolLabel("mcp__paseo__list_workspaces")).toBe("List workspaces");
    expect(toolLabel("ToolSearch")).toBe("Toolsearch");
    expect(toolLabel("mcp__gmail__search_threads")).toBe("mcp__gmail__search_threads");
    expect(toolIcon("Bash", { type: "shell" })).toBe("SquareTerminal");
    expect(toolIcon("anything", { type: "plain_text", icon: "square_terminal" })).toBe("SquareTerminal");
    expect(toolIcon("Task")).toBe("Bot");
    expect(toolIcon("thinking", { type: "unknown" })).toBe("Brain");
  });

  it("knows when details can open and when they're loading", () => {
    const running = buildToolCallPresentation({ name: "Read", status: "running", error: null, detail: { type: "unknown", input: null, output: null } });
    expect(running).toMatchObject({ isLoadingDetails: true, canOpenDetails: true });
    const empty = buildToolCallPresentation({ name: "X", status: "completed", error: null, detail: { type: "unknown", input: {}, output: null } });
    expect(empty.canOpenDetails).toBe(false);
    const plan = buildToolCallPresentation({ name: "plan", status: "completed", error: null, detail: { type: "plan", text: "do" }, metadata: { approved: true } });
    expect(plan).toMatchObject({ isPlan: true, planOutcome: "approved" });
  });
});

describe("task lists", () => {
  it("parses TodoWrite and update_plan", () => {
    expect(extractTaskEntriesFromToolCall("TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "Doing a" }] })).toEqual([{ text: "Doing a", completed: true }]);
    expect(extractTaskEntriesFromToolCall("update_plan", { plan: [{ step: " b ", status: "weird" }] })).toEqual([{ text: "b", completed: false }]);
    expect(extractTaskEntriesFromToolCall("TodoWrite", { todos: [{ content: "a" }] })).toBeNull();
    expect(extractTaskEntriesFromToolCall("Read", {})).toBeNull();
  });

  it("derives added tasks", () => {
    expect(deriveTaskActivities([{ text: "a", completed: false }], [{ text: "a", completed: false }, { text: "b", completed: false }])).toEqual([{ type: "added", task: "b" }]);
  });
});

describe("diffs", () => {
  it("builds line diffs with word segments", () => {
    const diff = buildLineDiff("a\nold line\nc", "a\nnew line\nc");
    expect(diff.map((line) => line.type)).toEqual(["context", "remove", "add", "context"]);
    expect(diff[1]!.segments).toEqual([
      { text: "old", changed: true },
      { text: " line", changed: false },
    ]);
  });

  it("parses unified diffs", () => {
    expect(parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b").map((line) => line.type)).toEqual(["header", "remove", "add"]);
  });
});

describe("question forms", () => {
  const input = {
    questions: [
      { question: "Pick one", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
      { question: "Pick many", header: "Tags", options: [{ label: "a" }, { label: "b" }], multiSelect: true, allowOther: true },
    ],
  };

  it("parses questions and builds answers", () => {
    const questions = parseQuestionFormQuestions(input)!;
    expect(questions).toHaveLength(2);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]), 1: new Set([0]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]), 1: new Set([0, 1]) }, { 1: "custom" })).toEqual({ Color: "Blue", Tags: "a, b, custom" });
    expect(resolveDismissLabel(questions)).toBe("Dismiss");
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(false);
    expect(parseQuestionFormQuestions({ questions: [{ question: 1 }] })).toBeNull();
  });
});

describe("find in chat", () => {
  it("matches what the user and the bot wrote, not tools or thoughts", () => {
    const items = layoutStream(
      buildRows(
        [
          entry({ type: "user_message", text: "Where is the Invoice?" }, { seqStart: 1 }),
          entry({ type: "reasoning", text: "invoice lookup" }, { seqStart: 2 }),
          entry({ type: "tool_call", name: "invoice_search", status: "completed", callId: "c1" }, { seqStart: 3 }),
          entry({ type: "assistant_message", text: "The invoice is in Drive." }, { seqStart: 4 }),
        ],
        false,
      ),
      false,
    ).items;
    const matched = findRows(items, "invoice").map((index) => items[index]!.row.kind);
    expect(matched).toEqual(["user", "assistant"]);
    expect(findRows(items, "")).toEqual([]);
  });
});
