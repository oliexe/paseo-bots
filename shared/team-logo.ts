// Deterministic pixel-art team logos: a cute motif (a strawberry, a star, a
// mushroom...) on a rounded tile. As with bot avatars only a seed and an optional
// colour are stored; the motif and colours come from them here, so every client
// draws the same logo.
//
// Each motif is hand-drawn on a 12×12 area of a 16×16 grid and shaded the way the
// avatars are: light from the top-left, two shadow tones and a coloured outline.

import { buildPalette, darkBackground, PALETTES, pick, rng, toRuns, type Palette, type PaletteDef, type PixelRun } from "./pixel";

export const LOGO_SIZE = 16;

/**
 * Art legend: "." empty, "#" the main shape (the team's colour unless the motif
 * fixes it), "a" a second shape, "h" a highlight on the main shape, "L" a thin
 * line in the outline colour, and flat details from FLAT.
 */
interface MotifDef {
  art: readonly string[];
  /** The "#" colour; the team's when absent. */
  primary?: PaletteDef;
  /** The "a" colour: fixed, or the team's. */
  secondary?: PaletteDef | "team";
}

/** Unshaded details: w white, k eyes, p blush, m mouth, y gold, r red, o orange. */
const FLAT: Record<string, string> = {
  w: "#FFFFFF",
  k: "#2B2438",
  p: "#FF8FAB",
  m: "#4A2A3C",
  y: "#FFD54A",
  r: "#FF5A6E",
  o: "#FF9F43",
};

const RED: PaletteDef = { h: 352, s: 80, l: 64 };
const GREEN: PaletteDef = { h: 118, s: 45, l: 58 };
const GOLD: PaletteDef = { h: 44, s: 95, l: 64 };
const CREAM: PaletteDef = { h: 38, s: 60, l: 86 };
const WAFFLE: PaletteDef = { h: 32, s: 62, l: 66 };
const CLOUD: PaletteDef = { h: 210, s: 60, l: 88 };
const CLAY: PaletteDef = { h: 16, s: 55, l: 62 };
const SILVER: PaletteDef = { h: 220, s: 22, l: 86 };

const MOTIFS = {
  heart: {
    art: [
      ".####..####.",
      "#h##########",
      "############",
      "###k####k###",
      "##pk####kp##",
      ".####mm####.",
      "..########..",
      "...######...",
      "....####....",
      ".....##.....",
    ],
  },
  star: {
    art: [
      ".....##.....",
      "....#h##....",
      "....####....",
      "############",
      ".##########.",
      "..#k####k#..",
      "...##mm##...",
      "..########..",
      "..###..###..",
      ".###....###.",
      ".##......##.",
    ],
  },
  strawberry: {
    primary: RED,
    secondary: GREEN,
    art: [
      ".....aa.....",
      "..aaaaaaaa..",
      ".##aaaaaa##.",
      "############",
      "#h#y###y##y#",
      "############",
      ".##y###y###.",
      ".##########.",
      "..###y##y#..",
      "...######...",
      "....####....",
    ],
  },
  mushroom: {
    secondary: CREAM,
    art: [
      "....####....",
      "..##ww####..",
      ".###ww###w#.",
      "#########ww#",
      "#ww#########",
      ".##########.",
      "...aaaaaa...",
      "...akaaka...",
      "...apaapa...",
      "...aaaaaa...",
      "....aaaa....",
    ],
  },
  cherries: {
    primary: RED,
    secondary: GREEN,
    art: [
      "......aaa...",
      ".....a.a....",
      "....a...a...",
      "...a.....a..",
      "..a......a..",
      ".###....###.",
      "#####..#####",
      "#h###..#h###",
      "#####..#####",
      ".###....###.",
    ],
  },
  cloud: {
    primary: CLOUD,
    art: [
      "....####....",
      ".##.####.##.",
      "############",
      "############",
      "###k####k###",
      "###p#mm#p###",
      ".##########.",
    ],
  },
  moon: {
    primary: GOLD,
    art: [
      "....####....",
      "..####......",
      "..###.......",
      ".###.....w..",
      ".###....www.",
      ".###.....w..",
      ".###........",
      "..###.......",
      "..####......",
      "....####....",
    ],
  },
  paw: {
    art: [
      "...##..##...",
      "...##..##...",
      "##.##..##.##",
      "##........##",
      "##..####..##",
      "...######...",
      "..########..",
      "..########..",
      "...######...",
    ],
  },
  sprout: {
    primary: GREEN,
    secondary: CLAY,
    art: [
      ".##......##.",
      "####....####",
      ".####..####.",
      "...######...",
      ".....##.....",
      "..aaaaaaaa..",
      "..aaaaaaaa..",
      "...akaaka...",
      "...aammaa...",
      "....aaaa....",
    ],
  },
  flower: {
    secondary: GOLD,
    art: [
      ".###....###.",
      "#####..#####",
      "#h###..#####",
      "####aaaa####",
      ".##aaaaaa##.",
      "...akaaka...",
      "...aammaa...",
      ".##aaaaaa##.",
      "####aaaa####",
      "#####..#####",
      "#####..#####",
      ".###....###.",
    ],
  },
  rocket: {
    primary: SILVER,
    secondary: "team",
    art: [
      ".....##.....",
      "....####....",
      "....#h##....",
      "...######...",
      "...##aa##...",
      "...#aaaa#...",
      "...##aa##...",
      "...######...",
      "..a######a..",
      ".aa######aa.",
      ".aa.oyyo.aa.",
      ".....oo.....",
    ],
  },
  crown: {
    primary: GOLD,
    secondary: "team",
    art: [
      ".w...ww...w.",
      ".#...##...#.",
      ".##..##..##.",
      ".###.##.###.",
      ".##########.",
      ".##a#aa#a##.",
      ".##########.",
      ".##########.",
    ],
  },
  icecream: {
    secondary: WAFFLE,
    art: [
      ".....rr.....",
      "...######...",
      "..#h######..",
      ".##########.",
      ".###k##k###.",
      ".####mm####.",
      "..aaaaaaaa..",
      "...aaaaaa...",
      "...aaaaaa...",
      "....aaaa....",
      "....aaaa....",
      ".....aa.....",
    ],
  },
  gem: {
    art: [
      "...######...",
      "..#h######..",
      ".##h#######.",
      "############",
      ".##########.",
      "..########..",
      "...######...",
      "....####....",
      ".....##.....",
    ],
  },
} satisfies Record<string, MotifDef>;

export type MotifName = keyof typeof MOTIFS;
export const MOTIF_NAMES = Object.keys(MOTIFS) as MotifName[];

export interface TeamLogoImage {
  motif: MotifName;
  background: string;
  /** Runs per row of the 16×16 grid, top to bottom. */
  rows: PixelRun[][];
}

function draw(motif: MotifName, team: Palette): TeamLogoImage {
  const def: MotifDef = MOTIFS[motif];
  const primary = def.primary ? buildPalette(def.primary) : team;
  const secondary = def.secondary === "team" || !def.secondary ? team : buildPalette(def.secondary);
  const grid = Array.from({ length: LOGO_SIZE }, () => Array.from({ length: LOGO_SIZE }, () => "."));
  const top = Math.floor((LOGO_SIZE - def.art.length) / 2);
  def.art.forEach((line, dy) => {
    const left = Math.floor((LOGO_SIZE - line.length) / 2);
    line.split("").forEach((char, dx) => (grid[top + dy]![left + dx] = char));
  });
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < LOGO_SIZE && y < LOGO_SIZE ? grid[y]![x]! : ".");
  // Thin lines neither take nor cast shading and outline.
  const solid = (x: number, y: number) => at(x, y) !== "." && at(x, y) !== "L";
  const midY = top + (def.art.length - 1) / 2;

  const shaded = (palette: Palette, x: number, y: number) => {
    const bottom = !solid(x, y + 1);
    if (bottom && y >= midY) return palette.deep;
    if (bottom || !solid(x + 1, y) || (y >= midY && !solid(x, y + 2))) return palette.shade;
    if (!solid(x, y - 1) || !solid(x - 1, y)) return palette.light;
    return palette.body;
  };

  const colors = grid.map((line, y) =>
    line.map((char, x): string | null => {
      if (char === "#") return shaded(primary, x, y);
      if (char === "a") return shaded(secondary, x, y);
      if (char === "h") return primary.highlight;
      if (char === "L") return primary.outline;
      if (char !== ".") return FLAT[char] ?? null;
      const edge = solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1);
      return edge ? primary.outline : null;
    }),
  );
  return { motif, background: team.background, rows: toRuns(colors) };
}

export interface LogoOptions {
  /** Drawn on a dark theme: the tile is toned down like avatar backgrounds. */
  dark?: boolean;
}

function themed(motif: MotifName, team: Palette, options: LogoOptions): TeamLogoImage {
  const image = draw(motif, team);
  return options.dark ? { ...image, background: darkBackground(team) } : image;
}

/** A team's logo from its seed; `palette` pins the team colour. */
export function teamLogo(seed: string, palette: number | null = null, options: LogoOptions = {}): TeamLogoImage {
  const next = rng(`team:${seed}`);
  const motif = pick(next, MOTIF_NAMES);
  const seeded = pick(next, PALETTES);
  return themed(motif, palette === null ? seeded : PALETTES[palette % PALETTES.length]!, options);
}
