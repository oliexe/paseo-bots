import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Platform, Pressable, Text, View, type StyleProp, type TextStyle } from "react-native";
import { nativeTokens, useHover } from "../../native";
import { ui } from "../../typography";

type Colors = PluginTheme["colors"];

export const isWeb = Platform.OS === "web";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface StyleNode {
  id: string;
  textContent: string | null;
}
const dom = globalThis as unknown as {
  document?: {
    getElementById(id: string): StyleNode | null;
    createElement(tag: "style"): StyleNode;
    head?: { appendChild(node: StyleNode): void };
  };
};

/** Adds a stylesheet to the page once (web only). */
function ensureStyle(id: string, css: string): void {
  const document = dom.document;
  if (!isWeb || !document?.head) return;
  const existing = document.getElementById(id);
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const node = document.createElement("style");
  node.id = id;
  node.textContent = css;
  document.head.appendChild(node);
}

/** Paseo's LoadingSpinner: an ActivityIndicator, scaled for sizes under the platform's small one. */
export function Spinner({ color, size = 20 }: { color: string; size?: number }) {
  const scale = size / 20;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="small" color={color} style={scale === 1 ? undefined : { transform: [{ scale }] }} />
    </View>
  );
}

// ---------------------------------------------------------------- shimmer

const SHIMMER_CSS = `
@keyframes pbot-toolcall-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -20% 0; } }
[data-pbot-shimmer] {
  color: inherit;
  background-image: linear-gradient(90deg, currentColor 0%, currentColor 38%, #ffffff 50%, currentColor 62%, currentColor 100%);
  background-size: 300% 100%;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation-name: pbot-toolcall-shimmer;
  animation-duration: 1.6s;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}`;

/** message.tsx computeShimmerMetrics: a sweep slower for longer labels. */
export function shimmerDuration(label: string, secondary?: string): number {
  const chars = label.trim().length + (secondary?.trim().length ?? 0);
  const adjust = chars <= 12 ? 0.25 : 0;
  return Math.max(1, Math.min(2.3, 1.25 + chars * 0.008 - adjust));
}

/**
 * Props for a running tool label. On web the text gets Paseo's moving highlight
 * (a clipped gradient); phones pulse its opacity instead, since plugins have no
 * masked views.
 */
export function useShimmer(active: boolean, duration: number): { textProps: object; style: StyleProp<TextStyle> } {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) return;
    if (isWeb) {
      ensureStyle("pbot-toolcall-shimmer", SHIMMER_CSS);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: (duration * 1000) / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: (duration * 1000) / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      opacity.setValue(1);
    };
  }, [active, duration, opacity]);
  if (!active) return { textProps: {}, style: null };
  if (isWeb) {
    return { textProps: { dataSet: { pbotShimmer: "" } }, style: { animationDuration: `${duration.toFixed(2)}s` } as TextStyle };
  }
  return { textProps: {}, style: { opacity } as unknown as TextStyle };
}

// ---------------------------------------------------------------- buttons

/** Paseo's TurnCopyButton: Copy 14 muted, foreground on hover, Check for 1.5s after copying. */
export const CopyButton = memo(function CopyButton({
  colors,
  getContent,
  label = "Copy turn",
  style,
}: {
  colors: Colors;
  getContent(): string;
  label?: string;
  style?: object;
}) {
  const [copied, setCopied] = useState(false);
  const { hovered, hoverProps } = useHover();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    const text = getContent();
    if (!text) return;
    void copyText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? "Copied" : label} onPress={copy} {...hoverProps} style={[{ padding: 4 }, style]}>
      <Icon name={copied ? "Check" : "Copy"} size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
});

/** Paseo's Button size="sm" variant="secondary": 32 high, radius 12, surface3. */
export function SecondaryButton({ colors, label, disabled, onPress }: { colors: Colors; label: string; disabled?: boolean; onPress(): void }) {
  const tokens = nativeTokens(colors);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: tokens.surface3,
        backgroundColor: tokens.surface3,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: ui(14), color: colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/** The buttons under a permission or proposal card (agent-stream/view.tsx PermissionRequestCard). */
export function CardButton({ colors, label, icon, primary = false, busy = false, spinning = false, onPress }: { colors: Colors; label: string; icon: string; primary?: boolean; busy?: boolean; spinning?: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const tint = primary ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        alignItems: "center",
        borderWidth: 1,
        backgroundColor: hovered ? colors.surface2 : colors.surface1,
        borderColor: nativeTokens(colors).borderAccent,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {spinning ? (
        <Spinner color={tint} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={icon} size={14} color={tint} />
          <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------- expandable badge

export interface ExpandableBadgeProps {
  colors: Colors;
  label: string;
  secondaryLabel?: string;
  icon?: string;
  isExpanded: boolean;
  onToggle?(): void;
  renderDetails?(): ReactNode;
  isLoading?: boolean;
  isError?: boolean;
}

/** Paseo's ExpandableBadge (message.tsx): the tool call row and its attached detail panel. */
export const ExpandableBadge = memo(function ExpandableBadge({ colors, label, secondaryLabel, icon, isExpanded, onToggle, renderDetails, isLoading = false, isError = false }: ExpandableBadgeProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onToggle);
  const active = hovered || isExpanded;
  const duration = shimmerDuration(label, secondaryLabel);
  const shimmer = useShimmer(isLoading, duration);
  const details = isExpanded && renderDetails ? renderDetails() : null;
  const labelStyle: TextStyle = {
    color: isLoading || active ? colors.foreground : colors.foregroundMuted,
    opacity: isLoading ? 0.72 : 1,
    fontSize: ui(14),
    flexShrink: 0,
  };
  let iconNode: ReactNode = null;
  if (interactive && active) {
    iconNode = (
      <View style={{ marginLeft: -4, transform: isExpanded ? [{ scale: 1.3 }, { rotate: "90deg" }] : [{ scale: 1.3 }] }}>
        <Icon name="ChevronRight" size={12} color={colors.foreground} />
      </View>
    );
  } else if (isError) {
    iconNode = (
      <View style={{ marginLeft: -1, opacity: 0.8 }}>
        <Icon name="TriangleAlert" size={12} color={colors.statusDanger} />
      </View>
    );
  } else if (icon) {
    iconNode = (
      <View style={{ marginLeft: -1 }}>
        <Icon name={icon} size={12} color={active ? colors.foreground : colors.foregroundMuted} />
      </View>
    );
  }
  return (
    <View style={{ marginHorizontal: -13 }}>
      <Pressable
        accessibilityRole={interactive ? "button" : undefined}
        accessibilityLabel={secondaryLabel ? `${label} ${secondaryLabel}` : label}
        accessibilityState={interactive ? { expanded: isExpanded } : undefined}
        disabled={!interactive}
        onPress={onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({
          borderRadius: 8,
          borderWidth: 1,
          borderColor: isExpanded ? colors.border : "transparent",
          paddingHorizontal: 8,
          paddingVertical: 4,
          overflow: "hidden",
          opacity: pressed && interactive ? 0.9 : 1,
          ...(isExpanded ? { backgroundColor: colors.surface1, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}),
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginRight: 4 }}>{iconNode}</View>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", overflow: "hidden" }}>
            <Animated.Text numberOfLines={1} {...shimmer.textProps} style={[labelStyle, shimmer.style]}>
              {label}
            </Animated.Text>
            {secondaryLabel ? (
              <Animated.Text
                numberOfLines={1}
                {...shimmer.textProps}
                style={[{ flexShrink: 1, minWidth: 0, marginLeft: 8, fontSize: ui(14), color: active ? colors.foreground : colors.foregroundMuted }, shimmer.style]}
              >
                {secondaryLabel}
              </Animated.Text>
            ) : null}
          </View>
        </View>
      </Pressable>
      {details ? (
        <View
          style={{
            borderBottomLeftRadius: 8,
            borderBottomRightRadius: 8,
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: colors.border,
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            ...(isWeb ? ({ cursor: "auto", userSelect: "text" } as object) : {}),
          }}
        >
          {details}
        </View>
      ) : null}
    </View>
  );
});
