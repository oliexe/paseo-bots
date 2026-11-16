import type { PixelRun } from "./pixel";

/** Only literal hex colours can become SVG attributes; no markup, URLs or CSS. */
function color(value: string): string | null {
  return /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value) ? value : null;
}

/** The web renderer uses one image instead of hundreds of React Native views. */
export function pixelSpriteDataUri(sprite: { background: string; rows: PixelRun[][] }, size: number, radius: number, grid: number, inset: boolean): string {
  if (![size, radius, grid].every(Number.isFinite) || size <= 0 || grid <= 0) return "";
  const inner = !inset || size <= 24 ? size : size * 0.82;
  const pixel = inner / grid;
  const offset = (size - inner) / 2;
  const corners = Math.max(0, Math.min(radius, size / 2));
  const rects: string[] = [];
  for (let y = 0; y < Math.min(sprite.rows.length, grid); y++) {
    for (const run of sprite.rows[y]!) {
      const fill = run.color && color(run.color);
      if (!fill || !Number.isFinite(run.x) || !Number.isFinite(run.width) || run.width <= 0 || run.x < 0 || run.x >= grid) continue;
      const width = Math.min(run.width, grid - run.x) * pixel + 0.3;
      rects.push(`<rect x="${offset + run.x * pixel}" y="${offset + y * pixel}" width="${width}" height="${pixel + 0.3}" fill="${fill}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><clipPath id="frame"><rect width="${size}" height="${size}" rx="${corners}"/></clipPath></defs><g clip-path="url(#frame)"><rect width="${size}" height="${size}" fill="${color(sprite.background) ?? "none"}"/>${rects.join("")}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
