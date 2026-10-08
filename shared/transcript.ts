import { localTime, toolLabel } from "./activity";
import { toolCallName } from "./tool-name";

// A chat as Markdown, like OpenMausBot's transcript export: who said what,
// when, and the tools the bot used in between.

interface TranscriptEntry {
  item: { type: string; text?: unknown; name?: unknown; status?: unknown; metadata?: unknown };
  timestamp: string;
}

/** Titles and names are plain text in the Markdown. */
function plain(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&");
}

export function chatTranscript(input: { title: string; botName: string; entries: readonly TranscriptEntry[]; exportedAt: Date }): string {
  const lines = [`# ${plain(input.title)}`, "", `_${plain(input.botName)} · exported ${input.exportedAt.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}_`];
  let speaker: string | null = null;
  let tools: string[] = [];
  const say = (who: string, at: string) => {
    if (who === speaker) return;
    lines.push("", "---", "", `### ${plain(who)} · ${localTime(new Date(at))}`);
    speaker = who;
  };
  const flushTools = () => {
    if (tools.length) lines.push("", `> Used ${tools.map((tool) => `\`${tool.replace(/`/g, "'")}\``).join(", ")}`);
    tools = [];
  };
  for (const { item, timestamp } of input.entries) {
    if (item.type === "tool_call" && typeof item.name === "string") {
      say(input.botName, timestamp);
      const label = toolLabel(toolCallName({ name: item.name, metadata: item.metadata }));
      tools.push(item.status === "failed" ? `${label} (failed)` : label);
      continue;
    }
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    flushTools();
    say(item.type === "user_message" ? "You" : input.botName, timestamp);
    lines.push("", text);
  }
  flushTools();
  if (speaker === null) lines.push("", "_No messages yet._");
  return `${lines.join("\n")}\n`;
}
