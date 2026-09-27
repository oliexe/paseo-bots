import { describe, expect, it } from "vitest";
import { chatTranscript } from "../shared/transcript";

describe("chat transcripts", () => {
  it("lists who said what, with the tools the bot used in between", () => {
    const at = (minute: number) => new Date(2026, 8, 27, 9, minute).toISOString();
    const text = chatTranscript({
      title: "Inbox *today*",
      botName: "Mail Bot",
      exportedAt: new Date(2026, 8, 27, 10, 0),
      entries: [
        { item: { type: "user_message", text: "Any new mail?" }, timestamp: at(1) },
        { item: { type: "reasoning", text: "thinking" }, timestamp: at(1) },
        { item: { type: "tool_call", name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", status: "completed" }, timestamp: at(2) },
        { item: { type: "tool_call", name: "Bash", status: "failed" }, timestamp: at(2) },
        { item: { type: "assistant_message", text: "Two new emails." }, timestamp: at(3) },
        { item: { type: "assistant_message", text: "Both from **Ana**." }, timestamp: at(3) },
      ],
    });
    expect(text.startsWith("# Inbox \\*today\\*\n\n_Mail Bot · exported ")).toBe(true);
    expect(text).toContain("### You · 09:01\n\nAny new mail?\n\n---\n\n### Mail Bot · 09:02\n\n> Used `composio/COMPOSIO_MULTI_EXECUTE_TOOL`, `Bash (failed)`\n\nTwo new emails.\n\nBoth from **Ana**.\n");
    expect(text).not.toContain("thinking");
  });

  it("says so when a chat is empty", () => {
    expect(chatTranscript({ title: "New chat", botName: "Bot", entries: [], exportedAt: new Date() })).toContain("_No messages yet._");
  });
});
