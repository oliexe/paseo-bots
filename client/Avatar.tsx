import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Image, Platform, View } from "react-native";
import { pixelAvatar, SPRITE_SIZE } from "../shared/avatar";
import { avatarStyle, smoothAvatar, type AvatarStyle } from "../shared/avatar-options";
import type { BotAvatar, BotGroup } from "../shared/bot";
import { teamLogoOf } from "../shared/groups";
import type { PixelRun } from "../shared/pixel";
import { pixelSpriteDataUri } from "../shared/pixel-svg";
import { LOGO_SIZE, teamLogo } from "../shared/team-logo";

interface AvatarProps {
  avatar: Pick<BotAvatar, "seed"> & Partial<BotAvatar>;
  size: number;
  /** Overrides the surrounding AvatarTheme; sheets need it, as Paseo draws them outside the plugin's tree on phones. */
  dark?: boolean;
}

const AvatarThemeContext = createContext(false);

/** Tells every Avatar below it whether the theme is dark, so pastel backgrounds are toned down. */
export function AvatarTheme({ dark, children }: { dark: boolean; children: ReactNode }) {
  return <AvatarThemeContext.Provider value={dark}>{children}</AvatarThemeContext.Provider>;
}

function radiusFor(shape: BotAvatar["shape"] | undefined, size: number): number {
  return shape === "square" ? size * 0.12 : shape === "rounded" ? size * 0.28 : size / 2;
}

export function Avatar({ avatar, size, dark: darkProp }: AvatarProps) {
  const themeDark = useContext(AvatarThemeContext);
  const dark = darkProp ?? themeDark;
  const palette = avatar.palette ?? null;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const radius = radiusFor(avatar.shape, size);
  if (avatar.imageUrl && avatar.imageUrl !== failedImage) {
    return <Image accessibilityIgnoresInvertColors source={{ uri: avatar.imageUrl }} onError={() => setFailedImage(avatar.imageUrl ?? null)} style={{ width: size, height: size, borderRadius: radius }} />;
  }
  return <GeneratedAvatar seed={avatar.seed} palette={palette} style={avatarStyle(avatar.style)} dark={dark} size={size} radius={radius} />;
}

function GeneratedAvatar({ seed, palette, style, dark, size, radius }: { seed: string; palette: number | null; style: AvatarStyle; dark: boolean; size: number; radius: number }) {
  const sprite = useMemo(() => style === "pixel" ? pixelAvatar(seed, palette, { dark }) : null, [seed, palette, dark, style]);
  const smooth = useMemo(() => style !== "pixel" ? smoothAvatar(seed, style, palette, dark) : null, [seed, palette, dark, style]);
  if (smooth) return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: radius, backgroundColor: smooth.background, overflow: "hidden" }}>
      {smooth.layers.map((layer, index) => <View key={index} style={{ position: "absolute", left: layer.x * size / 100, top: layer.y * size / 100, width: layer.width * size / 100, height: layer.height * size / 100, borderRadius: layer.radius * size / 100, backgroundColor: layer.color, opacity: layer.opacity ?? 1, transform: [{ rotate: `${layer.rotation ?? 0}deg` }] }} />)}
    </View>
  );
  if (!sprite) return null;
  return <PixelSprite sprite={sprite} size={size} radius={radius} />;
}

/** A team's logo: its picture, or the generated pixel-art motif on a rounded tile. */
export function TeamLogo({ group, size, dark: darkProp }: { group: Pick<BotGroup, "id" | "logo">; size: number; dark?: boolean }) {
  const themeDark = useContext(AvatarThemeContext);
  const dark = darkProp ?? themeDark;
  const logo = teamLogoOf(group);
  const image = useMemo(() => teamLogo(logo.seed, logo.palette, { dark }), [logo.seed, logo.palette, dark]);
  const radius = size / 4;
  if (logo.imageUrl) {
    return <Image accessibilityIgnoresInvertColors source={{ uri: logo.imageUrl }} style={{ width: size, height: size, borderRadius: radius }} />;
  }
  // The motif has its margin drawn in, so it fills the tile.
  return <PixelSprite sprite={image} size={size} radius={radius} grid={LOGO_SIZE} inset={false} />;
}

/**
 * Draws a generated sprite: one View per same-coloured run on a rounded background. Avatars
 * sit inset in their frame except when small; `inset` false fills it (team logos).
 */
export function PixelSprite({ sprite, size, radius = size / 2, grid = SPRITE_SIZE, inset = true }: { sprite: { background: string; rows: PixelRun[][] }; size: number; radius?: number; grid?: number; inset?: boolean }) {
  const uri = useMemo(() => Platform.OS === "web" ? pixelSpriteDataUri(sprite, size, radius, grid, inset) : null, [sprite, size, radius, grid, inset]);
  // Small avatars (sidebar rows) use the full frame so each sprite pixel stays about one point.
  const inner = !inset || size <= 24 ? size : size * 0.82;
  const pixel = inner / grid;
  if (uri) return <Image accessibilityElementsHidden importantForAccessibility="no-hide-descendants" accessibilityIgnoresInvertColors source={{ uri }} style={{ width: size, height: size, borderRadius: radius }} />;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: sprite.background, alignItems: "center", justifyContent: "center", overflow: "hidden" }}
    >
      <View style={{ width: inner, height: inner }}>
        {sprite.rows.map((runs, y) =>
          runs.map((run) =>
            run.color ? (
              <View
                key={`${y}-${run.x}`}
                style={{
                  position: "absolute",
                  left: run.x * pixel,
                  top: y * pixel,
                  // Overlap by a hair so fractional pixel sizes don't leave seams.
                  width: run.width * pixel + 0.3,
                  height: pixel + 0.3,
                  backgroundColor: run.color,
                }}
              />
            ) : null,
          ),
        )}
      </View>
    </View>
  );
}
