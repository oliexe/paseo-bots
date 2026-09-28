// The pieces bot avatars and team logos share: colour maths, the soft palettes,
// a seeded random source and run-length rows of pixels.

/** A horizontal run of same-coloured pixels; null colour is transparent. */
export interface PixelRun {
  x: number;
  width: number;
  color: string | null;
}

/** Run-length encodes rows of pixel colours, top to bottom. */
export function toRuns(colors: readonly (readonly (string | null)[])[]): PixelRun[][] {
  return colors.map((line) => {
    const runs: PixelRun[] = [];
    line.forEach((color, x) => {
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.width++;
      else runs.push({ x, width: 1, color });
    });
    return runs;
  });
}

// ------------------------------------------------------------------ colour

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Moves a hue toward a target by `amount` degrees the short way round. */
export function shiftHue(h: number, target: number, amount: number): number {
  const delta = ((target - h + 540) % 360) - 180;
  return h + Math.sign(delta) * Math.min(Math.abs(delta), amount);
}

export interface PaletteDef {
  h: number;
  s: number;
  l: number;
  /** A dark "night" backdrop instead of a pastel one. */
  night?: boolean;
}

// Soft, cute bodies. Shadows lean toward blue-violet and highlights toward yellow.
const PALETTE_DEFS: readonly PaletteDef[] = [
  { h: 150, s: 55, l: 70 }, // mint
  { h: 22, s: 90, l: 76 }, // peach
  { h: 258, s: 70, l: 80 }, // lavender
  { h: 205, s: 80, l: 74 }, // sky
  { h: 46, s: 90, l: 70 }, // butter
  { h: 335, s: 80, l: 80 }, // pink
  { h: 28, s: 50, l: 62 }, // caramel
  { h: 220, s: 14, l: 82 }, // cloud
  { h: 6, s: 85, l: 74 }, // coral
  { h: 176, s: 50, l: 60 }, // teal
  { h: 285, s: 55, l: 76, night: true }, // lilac on night
  { h: 215, s: 70, l: 72, night: true }, // blue on night
];

export interface Palette {
  outline: string;
  deep: string;
  shade: string;
  body: string;
  light: string;
  highlight: string;
  belly: string;
  background: string;
}

export function buildPalette({ h, s, l, night }: PaletteDef): Palette {
  return {
    outline: hslToHex(shiftHue(h, 260, 25), Math.min(s, 45), 24),
    deep: hslToHex(shiftHue(h, 250, 18), s * 0.8, l - 19),
    shade: hslToHex(shiftHue(h, 250, 10), s * 0.9, l - 9),
    body: hslToHex(h, s, l),
    light: hslToHex(shiftHue(h, 55, 8), s, Math.min(l + 8, 92)),
    highlight: hslToHex(shiftHue(h, 55, 10), Math.max(s - 25, 10), Math.min(l + 20, 97)),
    belly: hslToHex(shiftHue(h, 55, 10), Math.max(s - 20, 10), Math.min(l + 13, 94)),
    background: night ? hslToHex(232, 35, 16) : hslToHex(shiftHue(h, 55, 25), 70, 93),
  };
}

export const PALETTES: readonly Palette[] = PALETTE_DEFS.map(buildPalette);

// ------------------------------------------------------------------ randomness

function hash(seed: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  // mulberry32
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

/** Number of colour palettes a bot or team can pin its picture to. */
export const PALETTE_COUNT = PALETTES.length;

export function paletteSwatch(index: number): string {
  return PALETTES[index % PALETTES.length]!.body;
}

// ------------------------------------------------------------------ themes

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** `weight` of `a` blended with `b`, as #rrggbb. */
function blend(a: string, b: string, weight: number): string {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return "#" + x.map((channel, i) => Math.round(channel * weight + y[i]! * (1 - weight)).toString(16).padStart(2, "0")).join("");
}

/** Dark-theme background: a quiet tint of the body over near-black. Night palettes are already dark. */
const DARK_BASE = "#121416";
export function darkBackground(palette: { body: string; background: string }): string {
  return luminance(palette.background) < 0.5 ? palette.background : blend(palette.body, DARK_BASE, 0.24);
}
