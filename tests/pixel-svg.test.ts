import { describe, expect, it } from "vitest";
import { pixelAvatar } from "../shared/avatar";
import { pixelSpriteDataUri } from "../shared/pixel-svg";

const svgOf = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(",") + 1));

describe("pixel avatar image rendering", () => {
  it("keeps every coloured run and the same frame while using one image", () => {
    const sprite = pixelAvatar("support");
    const uri = pixelSpriteDataUri(sprite, 48, 24, 24, true);
    expect(uri).toBe(pixelSpriteDataUri(sprite, 48, 24, 24, true));
    expect(uri).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const svg = svgOf(uri);
    expect(svg).toContain('viewBox="0 0 48 48"');
    expect(svg).toContain('rx="24"');
    expect(svg).toContain(`fill="${sprite.background}"`);
    expect((svg.match(/<rect /g) ?? []).length).toBe(sprite.rows.flat().filter((run) => run.color).length + 2);
  });

  it("keeps the full sprite at chat size and preserves the larger inset", () => {
    const sprite = { background: "#fff", rows: [[{ x: 0, width: 1, color: "#123456" }]] };
    expect(svgOf(pixelSpriteDataUri(sprite, 24, 12, 24, true))).toContain('x="0" y="0" width="1.3"');
    expect(svgOf(pixelSpriteDataUri(sprite, 100, 20, 10, true))).toContain('x="9" y="9" width="8.5"');
    expect(svgOf(pixelSpriteDataUri(sprite, 100, 20, 10, false))).toContain('x="0" y="0" width="10.3"');
  });

  it("does not interpolate SVG markup or non-finite geometry", () => {
    const sprite = { background: '\"><script>alert(1)</script>', rows: [[{ x: 0, width: 1, color: 'url(https://example.com)' }, { x: NaN, width: 1, color: "#123456" }, { x: 1, width: Infinity, color: "#ffffff" }]] };
    const svg = svgOf(pixelSpriteDataUri(sprite, 48, 24, 24, true));
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("example.com");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expect(pixelSpriteDataUri(sprite, 48, 24, 0, true)).toBe("");
  });
});
