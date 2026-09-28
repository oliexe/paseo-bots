import { describe, expect, it } from "vitest";
import { pixelAvatar } from "../shared/avatar";
import { darkBackground } from "../shared/pixel";
import { botSettings, BotListUiSchema, DEFAULT_BOT_LIST_UI } from "../shared/bot";
import { aggregateBuckets, applyStoredOrdering, chatBucket, moveKey, orderChats } from "../shared/sidebar";

describe("chatBucket", () => {
  const base = { status: "idle", pendingPermissions: [], requiresAttention: false, attentionReason: null };

  it("puts a pending permission above an error", () => {
    expect(chatBucket({ ...base, status: "error", pendingPermissions: [{}] })).toBe("needs_input");
    expect(chatBucket({ ...base, attentionReason: "permission" })).toBe("needs_input");
  });

  it("maps errors, running and unread replies like Paseo", () => {
    expect(chatBucket({ ...base, status: "error" })).toBe("failed");
    expect(chatBucket({ ...base, attentionReason: "error" })).toBe("failed");
    expect(chatBucket({ ...base, status: "running", requiresAttention: true })).toBe("running");
    expect(chatBucket({ ...base, requiresAttention: true })).toBe("attention");
  });

  it("does not treat initializing as running", () => {
    expect(chatBucket({ ...base, status: "initializing" })).toBe("done");
  });
});

describe("aggregateBuckets", () => {
  it("keeps the most urgent, with running above attention", () => {
    expect(aggregateBuckets(["attention", "running", "done"])).toBe("running");
    expect(aggregateBuckets(["running", "failed"])).toBe("failed");
    expect(aggregateBuckets(["failed", "needs_input"])).toBe("needs_input");
    expect(aggregateBuckets([])).toBe("done");
  });
});

describe("applyStoredOrdering", () => {
  const key = (item: string) => item;

  it("reorders stored items within their own slots and leaves new ones in place", () => {
    expect(applyStoredOrdering(["new", "a", "b", "c"], ["c", "a", "b"], key)).toEqual(["new", "c", "a", "b"]);
  });

  it("ignores unknown and duplicate keys", () => {
    expect(applyStoredOrdering(["a", "b"], ["x", "b", "b", "a"], key)).toEqual(["b", "a"]);
    expect(applyStoredOrdering(["a", "b"], ["x"], key)).toEqual(["a", "b"]);
  });
});

describe("orderChats", () => {
  const chat = (id: string, createdAt: string, updatedAt: string) => ({ id, createdAt, updatedAt });
  const chats = [chat("old", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"), chat("new", "2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z")];

  it("sorts manual order newest-created first so replies don't reshuffle rows", () => {
    expect(orderChats(chats, "manual").map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(orderChats(chats, "manual", ["old", "new"]).map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("sorts by last activity when asked", () => {
    expect(orderChats(chats, "activity").map((entry) => entry.id)).toEqual(["old", "new"]);
  });
});

describe("moveKey", () => {
  it("swaps with the neighbour and stops at the edges", () => {
    expect(moveKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveKey(["a", "b"], "a", -1)).toBeNull();
    expect(moveKey(["a", "b"], "z", 1)).toBeNull();
  });
});

describe("bot list UI state", () => {
  it("is optional in the settings document and fills its defaults", () => {
    expect(botSettings.schema.parse({}).ui).toBeUndefined();
    expect(botSettings.schema.parse({ ui: {} }).ui).toEqual(DEFAULT_BOT_LIST_UI);
    expect(DEFAULT_BOT_LIST_UI).toEqual({ collapsed: [], pinnedCollapsed: false, pinnedChats: [], chatOrder: {}, chatSort: "manual", showArchived: false, tab: null, listWidth: 320, panelWidth: 320 });
  });

  it("rejects an unknown sort", () => {
    expect(BotListUiSchema.safeParse({ chatSort: "alphabetical" }).success).toBe(false);
  });
});

describe("dark avatar backgrounds", () => {
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };

  it("darkens pastel backgrounds and keeps the sprite", () => {
    for (let palette = 0; palette < 12; palette++) {
      const light = pixelAvatar("seed", palette);
      const dark = pixelAvatar("seed", palette, { dark: true });
      expect(dark.rows).toEqual(light.rows);
      expect(luminance(dark.background)).toBeLessThan(0.3);
    }
  });

  it("leaves already dark backgrounds alone", () => {
    expect(darkBackground({ body: "#93C5FD", background: "#0F172A" })).toBe("#0F172A");
  });

  it("is unchanged without the option", () => {
    expect(pixelAvatar("abc")).toEqual(pixelAvatar("abc", null, {}));
  });
});

import { CENTER_MIN_WIDTH, fitColumns } from "../shared/layout";

describe("fitColumns", () => {
  it("keeps the chat at least 400 wide, shrinking the panel before the list", () => {
    expect(fitColumns(1600, 320, 320)).toEqual({ list: 320, panel: 320 });
    const tight = fitColumns(1000, 320, 320);
    expect(tight).toEqual({ list: 320, panel: 280 });
    expect(1000 - tight.list - tight.panel!).toBeGreaterThanOrEqual(CENTER_MIN_WIDTH);
    expect(fitColumns(800, 320, 320)).toEqual({ list: 200, panel: 240 });
    expect(fitColumns(900, 700, null)).toEqual({ list: 500, panel: null });
  });
});

import { grayscaleAvatar, SPLASH_LINEUP, spriteAvatar } from "../shared/avatar";

describe("splash lineup", () => {
  it("has six different creatures, drawn in grays", () => {
    expect(new Set(SPLASH_LINEUP.map((entry) => entry.sprite)).size).toBe(6);
    const gray = grayscaleAvatar(spriteAvatar("cat", 5));
    const colours = [gray.background, ...gray.rows.flat().flatMap((run) => (run.color ? [run.color] : []))];
    for (const colour of colours) expect(colour).toMatch(/^#([0-9a-f]{2})\1\1$/);
  });
});

import { readFileSync } from "node:fs";
import { PLUGIN_VERSION } from "../shared/version";

describe("plugin version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});
