import { describe, expect, it } from "vitest";
import { AVATAR_STYLE_OPTIONS, avatarStyle, smoothAvatar } from "../shared/avatar-options";
import { botSettings } from "../shared/bot";
import { PALETTE_COUNT, luminance } from "../shared/pixel";
import { makeBot } from "./helpers";

describe("avatar styles", () => {
  it("preserves legacy pixel avatars and persists a chosen style", () => {
    const legacy = makeBot();
    expect(avatarStyle(legacy.avatar.style)).toBe("pixel");
    expect(avatarStyle("unknown-future-style")).toBe("pixel");
    for (const { value } of AVATAR_STYLE_OPTIONS) {
      const parsed = botSettings.schema.parse({ bots: [{ ...legacy, avatar: { ...legacy.avatar, style: value } }] });
      expect(parsed.bots[0]!.avatar.style).toBe(value);
    }
  });

  it("draws stable, distinct identities in each smooth style", () => {
    for (const style of ["modern", "orbital"] as const) {
      const first = smoothAvatar("inbox", style);
      expect(smoothAvatar("inbox", style)).toEqual(first);
      expect(smoothAvatar("research", style)).not.toEqual(first);
      expect(smoothAvatar("inbox", style, 3)).not.toEqual(smoothAvatar("inbox", style, 4));
      const identities = new Set(Array.from({ length: 50 }, (_, index) => JSON.stringify(smoothAvatar(String(index), style))));
      expect(identities.size).toBeGreaterThan(40);
    }
    expect(smoothAvatar("inbox", "modern")).not.toEqual(smoothAvatar("inbox", "orbital"));
  });

  it("keeps the drawing inside its frame and the face readable on a dark theme", () => {
    for (const style of ["modern", "orbital"] as const) {
      for (let seed = 0; seed < 80; seed++) {
        const light = smoothAvatar(String(seed), style, seed % PALETTE_COUNT);
        const dark = smoothAvatar(String(seed), style, seed % PALETTE_COUNT, true);
        expect(luminance(dark.background)).toBeLessThan(0.5);
        expect(dark.layers).toEqual(light.layers.map((layer) => layer.color === light.background ? { ...layer, color: dark.background } : layer));
        for (const layer of dark.layers) {
          expect(layer.x).toBeGreaterThanOrEqual(0);
          expect(layer.y).toBeGreaterThanOrEqual(0);
          expect(layer.x + layer.width).toBeLessThanOrEqual(100);
          expect(layer.y + layer.height).toBeLessThanOrEqual(100);
          expect(layer.color).toMatch(/^#[\da-f]{6}$/i);
        }
      }
    }
  });

  it("normalizes out-of-range palette indexes without losing the avatar", () => {
    expect(smoothAvatar("bot", "modern", -1)).toEqual(smoothAvatar("bot", "modern", PALETTE_COUNT - 1));
    expect(smoothAvatar("bot", "orbital", PALETTE_COUNT + 2)).toEqual(smoothAvatar("bot", "orbital", 2));
    expect(smoothAvatar("bot", "modern", NaN)).toEqual(smoothAvatar("bot", "modern"));
  });
});
