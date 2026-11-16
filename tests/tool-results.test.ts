import { describe, expect, it } from "vitest";
import { extractToolSources, toolSource } from "../shared/tool-results";
import { groupToolRows, layoutStream, type StreamRow, type ToolStreamRow } from "../client/chat/stream/model";

function step(key: string, patch: Partial<ToolStreamRow> = {}): ToolStreamRow {
  return { key, timestamp: Number(key) || 0, turnId: "turn-1", kind: "tool", name: "Read", status: "completed", error: null, detail: { type: "read", filePath: `/file-${key}.txt` }, ...patch };
}

describe("source cards", () => {
  it("keeps titles and domains, deduplicates fragments, and rejects executable or credential-bearing URLs", () => {
    const sources = extractToolSources({ type: "search", query: "Paseo", webResults: [
      { title: "Paseo docs", url: "https://www.paseo.sh/docs#first" },
      { title: "Same page", url: "https://www.paseo.sh/docs#second" },
      { title: "Unsafe", url: "javascript:alert(1)" },
      { title: "Password", url: "https://user:secret@example.com" },
      { title: "Local file", url: "file:///etc/passwd" },
      { title: "", url: "https://example.com/page" },
    ] });
    expect(sources).toEqual([
      { title: "Paseo docs", url: "https://www.paseo.sh/docs#first", domain: "paseo.sh" },
      { title: "example.com", url: "https://example.com/page", domain: "example.com" },
    ]);
    expect(toolSource({ url: "data:text/html,hi" })).toBeNull();
    expect(toolSource({ url: "//example.com" })).toBeNull();
    expect(toolSource({ url: null })).toBeNull();
    expect(toolSource(null)).toBeNull();
    expect(extractToolSources({ type: "search", webResults: "malformed" } as never)).toEqual([]);
    expect(extractToolSources({ type: "search", webResults: [null] } as never)).toEqual([]);
  });

  it("finds structured MCP search results through text content envelopes", () => {
    const sources = extractToolSources({ type: "unknown", input: {}, output: { content: [{ type: "text", text: JSON.stringify({ results: [
      { title: "First", url: "https://example.com/one", snippet: "An excerpt" },
      { name: "Second", link: "https://example.org/two", description: "More context" },
    ] }) }] } }, "mcp__web__search");
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ title: "First", description: "An excerpt" });
    expect(sources[1]).toMatchObject({ title: "Second", domain: "example.org" });
  });

  it("does not interpret unrelated app results or arbitrary prose as source cards", () => {
    expect(extractToolSources({ type: "unknown", input: {}, output: { results: [{ url: "https://example.com" }] } }, "gmail_send")).toEqual([]);
    expect(extractToolSources({ type: "unknown", input: {}, output: "See https://example.com for details" }, "web_search")).toEqual([]);
    expect(extractToolSources({ type: "unknown", input: {}, output: "{invalid json" }, "web_search")).toEqual([]);
    expect(extractToolSources({ type: "fetch", url: "https://example.org/about", result: "Hello" })).toEqual([{ title: "example.org", domain: "example.org", url: "https://example.org/about" }]);
  });

  it("bounds result count, text size and recursion even for hostile tool output", () => {
    const many = { type: "search" as const, query: "q", webResults: Array.from({ length: 1000 }, (_, i) => ({ title: "x".repeat(1000), url: `https://example.org/${i}` })) };
    const sources = extractToolSources(many);
    expect(sources).toHaveLength(20);
    expect(sources[0]!.title.length).toBe(300);
    const cycle: Record<string, unknown> = {};
    cycle.results = [cycle];
    expect(extractToolSources({ type: "unknown", input: {}, output: cycle }, "web_search")).toEqual([]);
    expect(toolSource({ url: `https://example.org/${"x".repeat(5000)}` })).toBeNull();
  });
});

describe("completed tool activity groups", () => {
  it("groups three consecutive completed steps and keeps their original keys/details", () => {
    const rows = [step("1"), step("2"), step("3")];
    const grouped = groupToolRows(rows);
    expect(grouped).toEqual([{ kind: "tool-group", key: "steps:1", turnId: "turn-1", timestamp: 3, tools: rows }]);
    expect(groupToolRows(rows.slice(0, 2))).toEqual(rows.slice(0, 2));
    expect(rows.map((row) => row.key)).toEqual(["1", "2", "3"]);
  });

  it("keeps running, failed and canceled steps visible and preserves group identity as it grows", () => {
    const completed = [step("1"), step("2"), step("3")];
    for (const status of ["running", "failed", "canceled"] as const) {
      const pending = step("4", { status });
      const grouped = groupToolRows([...completed, pending]);
      expect(grouped.map((row) => row.kind)).toEqual(["tool-group", "tool"]);
      expect(grouped[1]).toBe(pending);
    }
    expect(groupToolRows([...completed, step("4")])[0]!.key).toBe("steps:1");
    expect(groupToolRows([...completed, step("4", { error: "failed despite status" })])[1]!.kind).toBe("tool");
  });

  it("never absorbs a plan, a proposal, sign-in request, or a source result", () => {
    const protectedRows = [
      step("4", { detail: { type: "plan", text: "My plan" } }),
      step("4", { name: "bots.propose_routine", detail: { type: "unknown", input: {}, output: "Proposal p-1234567890: save this" } }),
      step("4", { name: "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", detail: { type: "unknown", input: {}, output: { data: { results: { gmail: { redirect_url: "https://connect.composio.dev/link/abc" } } } } } }),
      step("4", { name: "WebSearch", detail: { type: "search", query: "q", webResults: [{ title: "Source", url: "https://example.com" }] } }),
    ];
    for (const special of protectedRows) {
      const grouped = groupToolRows([step("1"), step("2"), step("3"), special, step("5"), step("6"), step("7")]);
      expect(grouped.map((row) => row.kind)).toEqual(["tool-group", "tool", "tool-group"]);
      expect(grouped[1]).toBe(special);
    }
  });

  it("does not combine turns or steps separated by a message", () => {
    const message: StreamRow = { key: "message", timestamp: 4, turnId: "turn-1", kind: "assistant", text: "Update", phase: "complete" };
    const grouped = groupToolRows([step("1"), step("2"), message, step("3"), step("4", { turnId: "turn-2" }), step("5", { turnId: "turn-2" }), step("6", { turnId: "turn-2" })]);
    expect(grouped.map((row) => row.kind)).toEqual(["tool", "tool", "assistant", "tool", "tool-group"]);
  });

  it("preserves answer copying and turn duration when steps collapse", () => {
    const rows: StreamRow[] = [
      { key: "user", timestamp: 0, turnId: "turn-1", kind: "user", text: "Do it" },
      step("1"), step("2"), step("3"),
      { key: "answer", timestamp: 1000, turnId: "turn-1", kind: "assistant", text: "Done", phase: "complete" },
    ];
    expect(layoutStream(groupToolRows(rows), false).auxiliaryFooter).toEqual(layoutStream(rows, false).auxiliaryFooter);
  });
});
