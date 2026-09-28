// Deterministic pixel-art avatars. The seed is the only thing stored on a bot;
// the creature, colours, face and accessory are derived from it here so every
// client draws the same bot.
//
// Each creature is a hand-drawn silhouette on a 24×24 grid (left half, mirrored).
// The generator then does what a pixel artist would: a coloured outline, light
// from the top-left (rim light, specular highlight, two shadow tones), a belly or
// muzzle patch, and a face and optional accessory layered on top.

import { darkBackground, hslToHex, luminance, PALETTES, pick, rng, shiftHue, toRuns, type Palette, type PixelRun } from "./pixel";

export const SPRITE_SIZE = 24;
const CENTER = SPRITE_SIZE / 2;

// ------------------------------------------------------------------ silhouettes

/** Mask legend: "." empty, "#" body, "a" accent (inner ears, feet, antenna). */
interface BodyDef {
  /** Left halves (12 columns) keyed by row; mirrored to 24 columns. */
  rows: Record<number, string>;
  /** Left eye's left column; the right eye mirrors it. */
  eyeX: number;
  eyeY: number;
  mouthY: number;
  blushY: number;
  /** Row where accessories sit. */
  top: number;
  accessories: AccessoryName[];
  /** Lighter belly or muzzle: centre row and radii. */
  patch?: { y: number; rx: number; ry: number };
  accent: "pink" | "orange" | "seeded";
  mouths?: MouthName[];
  eyes?: EyeName[];
}

const BODIES = {
  slime: {
    rows: {
      5: "........####",
      6: "......######",
      7: ".....#######",
      8: "....########",
      9: "...#########",
      10: "...#########",
      11: "..##########",
      12: "..##########",
      13: "..##########",
      14: ".###########",
      15: ".###########",
      16: ".###########",
      17: ".###########",
      18: ".###########",
      19: ".###########",
      20: "..##########",
    },
    eyeX: 7,
    eyeY: 11,
    mouthY: 15,
    blushY: 14,
    top: 5,
    accessories: ["sprout", "bow", "flower", "crown"],
    accent: "pink",
  },
  cat: {
    rows: {
      2: "...#........",
      3: "...##.......",
      4: "...#a#......",
      5: "...#aa#.....",
      6: "...#aaa#####",
      7: "...#########",
      8: "..##########",
      9: "..##########",
      10: ".###########",
      11: ".###########",
      12: ".###########",
      13: ".###########",
      14: ".###########",
      15: ".###########",
      16: "..##########",
      17: "..##########",
      18: "...#########",
      19: "....########",
      20: "......######",
    },
    eyeX: 6,
    eyeY: 11,
    mouthY: 15,
    blushY: 14,
    top: 6,
    accessories: ["bow", "flower"],
    patch: { y: 16, rx: 3.5, ry: 1.8 },
    accent: "pink",
    mouths: ["cat", "cat", "smile", "open", "tiny"],
  },
  bunny: {
    rows: {
      1: "....##......",
      2: "...####.....",
      3: "...#aa#.....",
      4: "...#aa#.....",
      5: "...#aa#.....",
      6: "...#aa#.....",
      7: "...#aa#.....",
      8: "....##......",
      9: "....########",
      10: "..##########",
      11: ".###########",
      12: ".###########",
      13: ".###########",
      14: ".###########",
      15: ".###########",
      16: ".###########",
      17: ".###########",
      18: "..##########",
      19: "..##########",
      20: "...#########",
      21: ".....#######",
    },
    eyeX: 6,
    eyeY: 13,
    mouthY: 17,
    blushY: 16,
    top: 9,
    accessories: ["bow", "flower"],
    patch: { y: 18, rx: 3.5, ry: 1.8 },
    accent: "pink",
  },
  bear: {
    rows: {
      2: "..####......",
      3: ".#aaaa#.....",
      4: ".#aa########",
      5: ".###########",
      6: ".###########",
      7: ".###########",
      8: ".###########",
      9: ".###########",
      10: ".###########",
      11: ".###########",
      12: ".###########",
      13: ".###########",
      14: ".###########",
      15: "..##########",
      16: "..##########",
      17: "...#########",
      18: "....########",
      19: "......######",
    },
    eyeX: 5,
    eyeY: 9,
    mouthY: 14,
    blushY: 12,
    top: 4,
    accessories: ["bow", "flower", "crown"],
    patch: { y: 14.5, rx: 4.2, ry: 2.6 },
    accent: "pink",
    mouths: ["smile", "tiny", "open", "cat"],
  },
  frog: {
    rows: {
      5: "...###......",
      6: "..#####.....",
      7: "..#####.....",
      8: "..##########",
      9: ".###########",
      10: ".###########",
      11: ".###########",
      12: ".###########",
      13: ".###########",
      14: ".###########",
      15: "..##########",
      16: "..##########",
      17: "...#########",
      18: ".....#######",
    },
    eyeX: 3,
    eyeY: 6,
    mouthY: 11,
    blushY: 10,
    top: 8,
    accessories: ["crown", "flower"],
    patch: { y: 15.5, rx: 5.5, ry: 2 },
    accent: "pink",
    mouths: ["wide", "wide", "smile", "open"],
    eyes: ["round", "big", "dot", "happy"],
  },
  chick: {
    rows: {
      1: "..........#.",
      2: "...........#",
      3: "........####",
      4: "......######",
      5: ".....#######",
      6: "....########",
      7: "...#########",
      8: "...#########",
      9: "..##########",
      10: "..##########",
      11: "..##########",
      12: ".###########",
      13: ".###########",
      14: ".###########",
      15: ".###########",
      16: ".###########",
      17: "..##########",
      18: "..##########",
      19: "...#########",
      20: ".....#######",
      21: ".......aa...",
    },
    eyeX: 7,
    eyeY: 10,
    mouthY: 13,
    blushY: 13,
    top: 3,
    accessories: ["flower", "bow"],
    patch: { y: 17, rx: 4.5, ry: 2.2 },
    accent: "orange",
    mouths: ["beak"],
  },
  ghost: {
    rows: {
      3: "........####",
      4: "......######",
      5: ".....#######",
      6: "....########",
      7: "...#########",
      8: "...#########",
      9: "..##########",
      10: "..##########",
      11: "..##########",
      12: ".###########",
      13: ".###########",
      14: "..##########",
      15: "..##########",
      16: "..##########",
      17: "..##########",
      18: "..##########",
      19: "..##########",
      20: "..####...###",
      21: "...##.....##",
    },
    eyeX: 7,
    eyeY: 9,
    mouthY: 13,
    blushY: 12,
    top: 3,
    accessories: ["bow", "crown", "flower"],
    accent: "pink",
    mouths: ["ooh", "smile", "open", "tiny"],
  },
  robot: {
    rows: {
      1: "...........a",
      2: "...........a",
      3: "...........#",
      4: "...#########",
      5: "..##########",
      6: "..##########",
      7: "..##########",
      8: "..##########",
      9: ".a##########",
      10: ".a##########",
      11: ".a##########",
      12: "..##########",
      13: "..##########",
      14: "..##########",
      15: "..##########",
      16: "...#########",
      17: ".......#####",
      18: ".....#######",
      19: "....######aa",
      20: "....########",
      21: "....########",
    },
    eyeX: 6,
    eyeY: 8,
    mouthY: 12,
    blushY: 11,
    top: 4,
    accessories: [],
    accent: "seeded",
    mouths: ["smile", "tiny", "open", "wide"],
    eyes: ["big", "round", "tall", "happy", "wink"],
  },
} satisfies Record<string, BodyDef>;

export type SpriteName = keyof typeof BODIES;
export const SPRITE_NAMES = Object.keys(BODIES) as SpriteName[];

// ------------------------------------------------------------------ faces

/** Legend: e eye, w shine, W soft glint. Both eyes use the same drawing so the shine sits top-left on each. */
const EYES = {
  round: ["we", "ee", "ee"],
  big: ["wee", "eee", "eeW"],
  tall: ["we", "ee", "ee", "eW"],
  happy: [".e.", "e.e"],
  dot: ["we", "ee"],
  wink: ["we", "ee", "ee"],
} as const;
type EyeName = keyof typeof EYES;
const DEFAULT_EYES: EyeName[] = ["round", "round", "big", "big", "tall", "happy", "happy", "dot", "wink"];

/** Legend: m mouth, t tongue, k beak, K beak shade. */
const MOUTHS = {
  smile: ["m..m", ".mm."],
  cat: ["m.mm.m", ".m..m."],
  open: ["mmmm", "mttm", ".mm."],
  tiny: ["mm"],
  ooh: [".mm.", "m..m", ".mm."],
  wide: ["m......m", ".mmmmmm."],
  beak: ["kkkk", ".KK."],
} as const;
type MouthName = keyof typeof MOUTHS;
const DEFAULT_MOUTHS: MouthName[] = ["smile", "smile", "cat", "open", "tiny", "ooh"];

// ------------------------------------------------------------------ accessories

/** Legend: G leaf, g leaf shade, r ribbon, R ribbon shade, p petal, y gold, Y gold shade. */
const ACCESSORIES = {
  sprout: { art: ["GG.GG", ".GgG.", "..g.."], place: "top" },
  bow: { art: ["rr.rr", "rRRRr", "rr.rr"], place: "side" },
  flower: { art: [".p.", "pyp", ".p."], place: "side" },
  crown: { art: ["y.y.y", "yyyyy", "YYYYY"], place: "top" },
} as const;
type AccessoryName = keyof typeof ACCESSORIES;

// ------------------------------------------------------------------ colour

const ACCENT_HUES = [345, 20, 48, 140, 190, 230, 285];
const FIXED = {
  eye: "#2B2438",
  shine: "#FFFFFF",
  glint: "#CFC8E8",
  mouth: "#4A2A3C",
  tongue: "#FF7F9C",
  blush: "#FF8FAB",
  pink: "#FFB3C7",
  pinkShade: "#F08BA6",
  orange: "#FFB347",
  orangeShade: "#E8892B",
  leaf: "#7CD67C",
  leafShade: "#3E9A4E",
  ribbon: "#FF6FA0",
  ribbonShade: "#D94A7C",
  petal: "#FFFFFF",
  gold: "#FFD54A",
  goldShade: "#E0A82E",
};

// ------------------------------------------------------------------ output

/** A horizontal run of same-coloured pixels; null colour is transparent. */
export interface PixelAvatar {
  sprite: SpriteName;
  background: string;
  body: string;
  /** Runs per row, top to bottom. */
  rows: PixelRun[][];
}

interface Traits {
  sprite: SpriteName;
  palette: Palette;
  accent: string;
  accentShade: string;
  eyes: EyeName;
  mouth: MouthName;
  blush: boolean;
  accessory: AccessoryName | null;
}

type Cell = { kind: "empty" } | { kind: "body" } | { kind: "accent" } | { kind: "paint"; color: string };

function draw(traits: Traits): PixelAvatar {
  const body: BodyDef = BODIES[traits.sprite];
  const grid: Cell[][] = Array.from({ length: SPRITE_SIZE }, () => Array.from({ length: SPRITE_SIZE }, (): Cell => ({ kind: "empty" })));
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < SPRITE_SIZE && y < SPRITE_SIZE;
  const kindAt = (x: number, y: number) => (inside(x, y) ? grid[y]![x]!.kind : "empty");
  const solid = (x: number, y: number) => kindAt(x, y) !== "empty";

  // Silhouette, mirrored.
  for (const [rowKey, half] of Object.entries(body.rows)) {
    const y = Number(rowKey);
    const full = half + half.split("").reverse().join("");
    for (let x = 0; x < SPRITE_SIZE; x++) {
      if (full[x] === "#") grid[y]![x] = { kind: "body" };
      else if (full[x] === "a") grid[y]![x] = { kind: "accent" };
    }
  }

  // Accessory, placed before outlining so it gets an outline too.
  if (traits.accessory) {
    const { art, place } = ACCESSORIES[traits.accessory];
    const width = art[0]!.length;
    const originX = place === "top" ? CENTER - Math.ceil(width / 2) : CENTER + 3;
    const originY = place === "top" ? body.top - art.length : body.top - 1;
    const paints: Record<string, string> = {
      G: FIXED.leaf,
      g: FIXED.leafShade,
      r: FIXED.ribbon,
      R: FIXED.ribbonShade,
      p: FIXED.petal,
      y: FIXED.gold,
      Y: FIXED.goldShade,
    };
    art.forEach((line, dy) =>
      line.split("").forEach((char, dx) => {
        const color = paints[char];
        if (color && inside(originX + dx, originY + dy)) grid[originY + dy]![originX + dx] = { kind: "paint", color };
      }),
    );
  }

  let minY = SPRITE_SIZE;
  let maxY = 0;
  grid.forEach((line, y) => {
    if (line.some((cell) => cell.kind === "body")) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  const midY = (minY + maxY) / 2;

  // Shading, lit from the top-left.
  const { palette } = traits;
  const colors: (string | null)[][] = grid.map((line, y) =>
    line.map((cell, x) => {
      if (cell.kind === "empty") return null;
      if (cell.kind === "paint") return cell.color;
      if (cell.kind === "accent") return !solid(x, y + 1) || !solid(x + 1, y) ? traits.accentShade : traits.accent;
      const bottom = !solid(x, y + 1);
      if (bottom && y >= midY) return palette.deep;
      if (bottom || !solid(x + 1, y) || (y >= midY && !solid(x, y + 2))) return palette.shade;
      if (!solid(x, y - 1) || !solid(x - 1, y)) return palette.light;
      if (body.patch) {
        const dx = (x + 0.5 - CENTER) / body.patch.rx;
        const dy = (y - body.patch.y) / body.patch.ry;
        if (dx * dx + dy * dy <= 1) return palette.belly;
      }
      return palette.body;
    }),
  );

  // Specular highlight: a small cluster near the top-left of the head.
  for (let y = minY + 1; y < maxY; y++) {
    const line = grid[y]!;
    if (line.filter((cell) => cell.kind === "body").length < 10) continue;
    const hx = line.findIndex((cell) => cell.kind === "body") + 2;
    for (const [sx, sy] of [
      [hx, y + 1],
      [hx + 1, y + 1],
      [hx, y + 2],
    ] as const) {
      if (kindAt(sx, sy) === "body" && solid(sx, sy - 1) && solid(sx - 1, sy)) colors[sy]![sx] = palette.highlight;
    }
    break;
  }

  // Face, painted only onto the body.
  const paintFace = (art: readonly string[], originX: number, originY: number, map: Record<string, string>) =>
    art.forEach((line, dy) =>
      line.split("").forEach((char, dx) => {
        const color = map[char];
        const px = originX + dx;
        const py = originY + dy;
        if (color && inside(px, py) && grid[py]![px]!.kind === "body") colors[py]![px] = color;
      }),
    );
  const eyeMap = { e: FIXED.eye, w: FIXED.shine, W: FIXED.glint };
  const rightArt = EYES[traits.eyes];
  const leftArt = traits.eyes === "wink" ? EYES.happy : rightArt;
  const eyeWidth = rightArt[0]!.length;
  const leftX = body.eyeX;
  const rightX = SPRITE_SIZE - body.eyeX - eyeWidth;
  paintFace(leftArt, leftX + eyeWidth - leftArt[0]!.length, body.eyeY + rightArt.length - leftArt.length, eyeMap);
  paintFace(rightArt, rightX, body.eyeY, eyeMap);

  const mouth = MOUTHS[traits.mouth];
  paintFace(mouth, Math.floor(CENTER - mouth[0]!.length / 2), body.mouthY, { m: FIXED.mouth, t: FIXED.tongue, k: FIXED.orange, K: FIXED.orangeShade });

  if (traits.blush) {
    paintFace(["cc"], leftX - 1, body.blushY, { c: FIXED.blush });
    paintFace(["cc"], rightX + eyeWidth - 1, body.blushY, { c: FIXED.blush });
  }

  // Outline: every empty pixel touching the shape.
  grid.forEach((line, y) =>
    line.forEach((cell, x) => {
      if (cell.kind === "empty" && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) colors[y]![x] = palette.outline;
    }),
  );

  return { sprite: traits.sprite, background: palette.background, body: palette.body, rows: toRuns(colors) };
}

function traitsFor(sprite: SpriteName, palette: Palette, accentHue: number, next: () => number): Traits {
  const body: BodyDef = BODIES[sprite];
  const accent =
    body.accent === "orange"
      ? { accent: FIXED.orange, accentShade: FIXED.orangeShade }
      : body.accent === "pink"
        ? { accent: FIXED.pink, accentShade: FIXED.pinkShade }
        : { accent: hslToHex(accentHue, 85, 72), accentShade: hslToHex(shiftHue(accentHue, 250, 14), 80, 58) };
  const eyes = pick(next, body.eyes ?? DEFAULT_EYES);
  const mouth = pick(next, body.mouths ?? DEFAULT_MOUTHS);
  const blush = next() < 0.75;
  const accessory = next() < 0.45 && body.accessories.length > 0 ? pick(next, body.accessories) : null;
  return { sprite, palette, ...accent, eyes, mouth, blush, accessory };
}

// ------------------------------------------------------------------ public API

export interface AvatarOptions {
  /** Drawn on a dark theme: pastel backgrounds become a deep tint of the body colour so they don't glare. */
  dark?: boolean;
}

function withTheme(avatar: PixelAvatar, palette: Palette, options: AvatarOptions): PixelAvatar {
  return options.dark ? { ...avatar, background: darkBackground(palette) } : avatar;
}

export function pixelAvatar(seed: string, palette: number | null = null, options: AvatarOptions = {}): PixelAvatar {
  const next = rng(seed);
  const sprite = pick(next, SPRITE_NAMES);
  const seeded = pick(next, PALETTES);
  const colors = palette === null ? seeded : PALETTES[palette % PALETTES.length]!;
  const accentHue = pick(next, ACCENT_HUES);
  return withTheme(draw(traitsFor(sprite, colors, accentHue, next)), colors, options);
}

/** A specific creature and palette, e.g. the robot on the Bots project icon. The face follows from the arguments. */
export function spriteAvatar(sprite: SpriteName, palette: number, accent: number = 0, options: AvatarOptions = {}): PixelAvatar {
  const colors = PALETTES[palette % PALETTES.length]!;
  const next = rng(`${sprite}:${palette}:${accent}`);
  return withTheme(draw(traitsFor(sprite, colors, ACCENT_HUES[accent % ACCENT_HUES.length]!, next)), colors, options);
}

/** The same avatar in grays: each colour becomes its luminance. */
export function grayscaleAvatar(avatar: PixelAvatar): PixelAvatar {
  const gray = (hex: string) => {
    const level = Math.round(luminance(hex) * 255).toString(16).padStart(2, "0");
    return `#${level}${level}${level}`;
  };
  return {
    ...avatar,
    background: gray(avatar.background),
    body: gray(avatar.body),
    rows: avatar.rows.map((runs) => runs.map((run) => (run.color ? { ...run, color: gray(run.color) } : run))),
  };
}

/** Six different creatures for the Bots splash screen. */
export const SPLASH_LINEUP: readonly { sprite: SpriteName; palette: number; accent: number }[] = [
  { sprite: "cat", palette: 5, accent: 0 },
  { sprite: "robot", palette: 3, accent: 5 },
  { sprite: "slime", palette: 0, accent: 3 },
  { sprite: "bunny", palette: 2, accent: 6 },
  { sprite: "chick", palette: 4, accent: 1 },
  { sprite: "ghost", palette: 9, accent: 4 },
];

/** The avatar as a crisp SVG (one rect per run) on a rounded background. */
export function avatarSvg(avatar: PixelAvatar, radius: number = 4.5): string {
  const rects = avatar.rows.flatMap((runs, y) =>
    runs.filter((run) => run.color).map((run) => `<rect x="${run.x}" y="${y}" width="${run.width}" height="1" fill="${run.color}"/>`),
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}" width="64" height="64" shape-rendering="crispEdges">`,
    `<rect width="${SPRITE_SIZE}" height="${SPRITE_SIZE}" rx="${radius}" fill="${avatar.background}"/>`,
    ...rects,
    "</svg>",
  ].join("");
}

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
