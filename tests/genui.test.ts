import { describe, expect, it } from "vitest";
import { GENUI_BLOCK_KIND, GENUI_TEXT_KIND } from "paseo-plugin-genui/shared/segment";
import { assistantGenUiItems } from "../client/chat/stream/genui";
import { buildRows } from "../client/chat/stream/model";
import { BOT_GENUI_INSTRUCTIONS } from "../shared/genui-instructions";

describe("bot chat GenUI blocks", () => {
  it("leaves ordinary assistant replies on the existing Markdown renderer", () => {
    expect(assistantGenUiItems("A plain answer.", "complete")).toBeNull();
  });

  it("does not tell bot chats to call GenUI's unavailable helper tool", () => {
    expect(BOT_GENUI_INSTRUCTIONS).toContain("[paseo-plugin-genui]");
    expect(BOT_GENUI_INSTRUCTIONS).toContain("correct it in your next reply");
    expect(BOT_GENUI_INSTRUCTIONS).not.toContain("render_ui");
  });

  it("projects text around ui and app fences into GenUI timeline items", () => {
    const items = assistantGenUiItems(
      'Here is a chart.\n\n```ui\nCard("Hello", [Text("World")])\n```\n\nAnd an app.\n\n```app\n<div>Hello</div>\n```',
      "complete",
    );

    expect(items?.map((item) => item.kind)).toEqual([
      GENUI_TEXT_KIND,
      GENUI_BLOCK_KIND,
      GENUI_TEXT_KIND,
      GENUI_BLOCK_KIND,
    ]);
    expect(items?.[1]).toMatchObject({ type: "plugin", kind: GENUI_BLOCK_KIND, data: { language: "ui", complete: true } });
    expect(items?.[3]).toMatchObject({ type: "plugin", kind: GENUI_BLOCK_KIND, data: { language: "app", complete: true } });
  });

  it("keeps an unfinished ui fence renderable while the bot is streaming", () => {
    const items = assistantGenUiItems("```ui\nCard(\"Loading\", [", "streaming", "message-1");

    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ type: "plugin", kind: GENUI_BLOCK_KIND, data: { language: "ui", complete: false, messageId: "message-1" } });
  });

  it("keeps the assistant message id for stable UI state across stream updates", () => {
    const rows = buildRows(
      [
        {
          provider: "codex",
          item: { type: "assistant_message", text: "```ui\nCard(\"Hello\", [])", messageId: "message-1" },
          timestamp: "2026-11-06T00:00:00.000Z",
          seqStart: 1,
          seqEnd: 1,
        },
      ],
      true,
    );

    expect(rows[0]).toMatchObject({ kind: "assistant", messageId: "message-1", phase: "streaming" });
  });
});
