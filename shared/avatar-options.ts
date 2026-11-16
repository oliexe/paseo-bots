import { darkBackground, PALETTES, rng } from "./pixel";

export const AVATAR_STYLES = ["pixel", "modern", "orbital"] as const;
export type AvatarStyle = typeof AVATAR_STYLES[number];
export const AVATAR_STYLE_OPTIONS: readonly { value: AvatarStyle; label: string; description: string }[] = [
  { value: "pixel", label: "Pixel", description: "A little pixel-art character" },
  { value: "modern", label: "Modern", description: "A smooth, expressive companion" },
  { value: "orbital", label: "Orbital", description: "A geometric mark in your colours" },
];

/** Keep legacy avatars pixel-based until their owner chooses another style. */
export function avatarStyle(value?: string): AvatarStyle {
  return value === "modern" || value === "orbital" ? value : "pixel";
}

export interface AvatarLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  color: string;
  rotation?: number;
  opacity?: number;
}

/** A 100-unit drawing made of rounded shapes, shared by every client and size. */
export function smoothAvatar(seed: string, style: Exclude<AvatarStyle, "pixel">, paletteIndex: number | null = null, dark = false): { background: string; layers: AvatarLayer[] } {
  const next = rng(seed);
  const automatic = Math.floor(next() * PALETTES.length);
  const index = paletteIndex !== null && Number.isSafeInteger(paletteIndex) ? ((paletteIndex % PALETTES.length) + PALETTES.length) % PALETTES.length : automatic;
  const palette = PALETTES[index]!;
  const variant = Math.floor(next() * 3);
  const tilt = Math.floor(next() * 13) - 6;
  const eyeHeight = 7 + Math.floor(next() * 5);
  const layers: AvatarLayer[] = [];
  const add = (x: number, y: number, width: number, height: number, radius: number, color: string, rotation?: number, opacity?: number) => layers.push({ x, y, width, height, radius, color, rotation, opacity });
  const background = dark ? darkBackground(palette) : palette.background;

  if (style === "orbital") {
    const angle = next() * Math.PI * 2;
    add(16, 16, 68, 68, 34, palette.shade, tilt);
    add(24, 24, 52, 52, 26, background);
    add(32, 32, 36, 36, variant === 0 ? 18 : 12, palette.body, tilt + 25);
    add(37, 35, 17, 10, 7, palette.highlight, tilt - 25, 0.75);
    add(43 + Math.cos(angle) * 30, 43 + Math.sin(angle) * 30, 14, 14, 7, palette.highlight);
    add(46 - Math.cos(angle) * 34, 46 - Math.sin(angle) * 34, 8, 8, 4, palette.deep);
  } else {
    // A broad face stays legible at 16 px; details add character at larger sizes.
    const radius = variant === 0 ? 30 : variant === 1 ? 21 : 15;
    if (variant === 2) {
      add(23, 18, 16, 26, 8, palette.shade, -18);
      add(62, 18, 16, 26, 8, palette.body, 18);
    } else {
      add(47, 14, 6, 18, 3, palette.shade, tilt);
      add(43, 11, 14, 12, 7, palette.body, tilt);
    }
    add(21, 29, 61, 56, radius, palette.deep, tilt);
    add(18, 25, 64, 56, radius, palette.body, tilt);
    add(26, 30, 32, 9, 5, palette.light, tilt - 10, 0.8);
    add(27, 42, 46, 27, 14, palette.outline, tilt);
    add(36, 49, 7, eyeHeight, 4, palette.highlight, tilt);
    add(57, 49, 7, eyeHeight, 4, palette.highlight, tilt);
    add(45, 72, 11, 3, 2, palette.deep, tilt);
  }
  return { background, layers };
}
