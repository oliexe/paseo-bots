import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions, type LayoutRectangle, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { MONO_FONT, MONO_PROPS, nativeTokens, useHover, withAlpha } from "../native";
import { fieldStateStyle, multilineStyle } from "../theme";
import { code, ui } from "../typography";
import { measureAnchor } from "../ui/Menu";

// Paseo primitives the plugin SDK doesn't hand out, rebuilt from their source:
// Button (components/ui/button.tsx), FormTextInput (form-field.tsx), SettingsTextArea
// (components/settings-textarea.tsx), SearchField, Alert, StatusBadge, Switch, and the
// settings row geometry (styles/settings.ts). Spacing stays on Paseo's 4/8/12/16/24 scale
// and text on the 12/14 UI tokens.

type Colors = PluginTheme["colors"];

const isWeb = Platform.OS === "web";

/** Paseo's compact form factor (unistyles xs/sm: under 720 wide) when the caller doesn't know. */
export function useCompact(compact?: boolean): boolean {
  const { width } = useWindowDimensions();
  return compact ?? width < 720;
}

// ---------------------------------------------------------------- button

type ButtonVariant = "default" | "secondary" | "outline" | "ghost";

export function Button({
  colors,
  label,
  onPress,
  variant = "secondary",
  size = "sm",
  disabled,
  loading,
  icon,
  style,
}: {
  colors: Colors;
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  const inactive = disabled || loading;
  const fill = variant === "default" ? colors.accent : variant === "secondary" ? tokens.surface3 : "transparent";
  const border = variant === "default" ? colors.accent : variant === "secondary" ? tokens.surface3 : variant === "outline" ? tokens.borderAccent : "transparent";
  const tint = variant === "default" ? colors.accentForeground : variant === "ghost" && !hovered ? colors.foregroundMuted : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: fill,
          minHeight: size === "md" ? 44 : size === "sm" ? 32 : 28,
          paddingHorizontal: size === "md" ? 16 : 12,
          borderRadius: size === "md" ? 16 : 12,
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={tint} /> : icon ? <Icon name={icon} size={size === "md" ? 16 : 14} color={tint} /> : null}
      <Text numberOfLines={1} style={{ fontSize: ui(size === "xs" ? 12 : 14), color: tint }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A sheet footer: equal-width Cancel + primary, like Paseo's schedule form (gap 12). */
export function SheetFooter({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 12 }}>{children}</View>;
}

/** Trailing actions under a sheet's text area, like "Append system prompt" (end-aligned, gap 8). */
export function SheetActions({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>{leading}</View>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- text areas

type AreaProps = Omit<TextInputProps, "style" | "multiline"> & {
  colors: Colors;
  minHeight?: number;
  monospace?: boolean;
};

/** Paseo's FormTextInput, multi-line: surface2, borderAccent on hover, 2px accent focus ring. */
export function FormTextArea({ colors, minHeight = 96, monospace, onFocus, onBlur, editable, ...props }: AreaProps) {
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable disabled={editable === false} {...hoverProps} style={{ width: "100%" }} accessible={false}>
      <TextInput
        {...props}
        {...(monospace ? MONO_PROPS : {})}
        editable={editable}
        multiline
        placeholderTextColor={colors.foregroundMuted}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[multilineStyle(colors, minHeight, monospace), fieldStateStyle(colors, { hovered, focused, disabled: editable === false })]}
      />
    </Pressable>
  );
}

/**
 * A multi-line input as a card row: optional label and hint, then a filled text
 * area across the row, matching `InputField` so single- and multi-line inputs
 * look the same. Render it inside a SettingsCard.
 */
export function TextAreaField({ colors, label, hint, error, ...props }: AreaProps & { label?: string; hint?: string | null; error?: string | null }) {
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      {label ? <RowText colors={colors} label={label} hint={hint} /> : null}
      <FormTextArea colors={colors} accessibilityLabel={label} {...props} />
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- fields

interface InputFieldProps extends Omit<TextInputProps, "style" | "multiline" | "defaultValue" | "value"> {
  colors: Colors;
  label: string;
  hint?: string | null;
  error?: string | null;
  /** Uncontrolled like Paseo's SettingsInput; remount with a `key` to reset it. */
  initialValue?: string;
  monospace?: boolean;
  disabled?: boolean;
}

/**
 * A settings card row whose input spans the row under its label. Paseo's
 * SettingsInput keeps the input beside the label and only wraps it at a fixed
 * width, which leaves it cramped in the 320-wide panel and short on phones.
 * The input is FormTextInput: 32 high with radius 6, or 44 and 8 on compact.
 */
export function InputField({ colors, label, hint, error, initialValue, monospace, disabled, onFocus, onBlur, ...props }: InputFieldProps) {
  const compact = useCompact();
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      <RowText colors={colors} label={label} hint={hint} />
      <Pressable disabled={disabled} {...hoverProps} accessible={false} style={{ width: "100%" }}>
        <TextInput
          accessibilityLabel={label}
          {...props}
          {...(monospace ? MONO_PROPS : {})}
          defaultValue={initialValue}
          editable={!disabled}
          placeholderTextColor={colors.foregroundMuted}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            {
              width: "100%",
              height: compact ? 44 : 32,
              paddingHorizontal: 12,
              borderRadius: compact ? 8 : 6,
              borderWidth: 1,
              borderColor: "transparent",
              backgroundColor: colors.surface2,
              color: colors.foreground,
              fontSize: monospace ? code() : ui(14),
              fontFamily: monospace ? MONO_FONT : undefined,
              outlineWidth: 0,
              outlineColor: "transparent",
            },
            fieldStateStyle(colors, { hovered, focused, disabled }),
          ]}
        />
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- search

/** Paseo's SearchField: 6/12 padding, radius 6, focus lifts to surface2 + borderAccent, clear X. */
export function SearchField({ colors, value, onChangeText, placeholder }: { colors: Colors; value: string; onChangeText(text: string): void; placeholder: string }) {
  const [focused, setFocused] = useState(false);
  const tokens = nativeTokens(colors);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: focused ? tokens.borderAccent : colors.border,
        backgroundColor: focused ? colors.surface2 : colors.surface1,
      }}
    >
      <Icon name="Search" size={14} color={colors.foregroundMuted} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        selectionColor={colors.foreground}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, minWidth: 0, padding: 0, height: 20, fontSize: ui(14), color: colors.foreground, outlineWidth: 0 }}
      />
      {value.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => onChangeText("")}>
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- alert, badge, switch

/** Paseo's Alert at size sm: 1px tinted border, transparent fill, 14pt icon, muted body. */
export function Alert({ colors, variant = "default", title, description }: { colors: Colors; variant?: "default" | "warning" | "error"; title?: string; description?: string | string[] }) {
  const accent = variant === "warning" ? colors.statusWarning : variant === "error" ? colors.statusDanger : null;
  const icon = variant === "warning" ? "AlertTriangle" : variant === "error" ? "CircleX" : null;
  const lines = description === undefined ? [] : Array.isArray(description) ? description : [description];
  const body = lines.map((line, index) => (
    <Text key={index} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
      {line}
    </Text>
  ));
  return (
    <View accessibilityRole="alert" style={{ borderWidth: 1, borderColor: accent ? withAlpha(accent, 0.5) : colors.border, backgroundColor: "transparent", borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {icon ? (
          <View style={{ width: 14, alignItems: "center" }}>
            <Icon name={icon} size={14} color={accent ?? colors.foreground} />
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>{title ? <Text style={{ fontSize: ui(14), fontWeight: "500", color: accent ?? colors.foreground }}>{title}</Text> : body[0]}</View>
      </View>
      {(title ? body : body.slice(1)).length ? <View style={{ marginLeft: icon ? 26 : 0 }}>{title ? body : body.slice(1)}</View> : null}
    </View>
  );
}

export type BadgeVariant = "success" | "warning" | "error" | "muted";

/** Paseo's StatusBadge: surface3 pill, or the status tint (12% light / 16% dark) with the status text. */
export function StatusBadge({ colors, label, variant = "muted" }: { colors: Colors; label: string; variant?: BadgeVariant }) {
  const tokens = nativeTokens(colors);
  const status = variant === "success" ? colors.statusSuccess : variant === "warning" ? colors.statusWarning : variant === "error" ? colors.statusDanger : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: status ? "transparent" : colors.border,
        backgroundColor: status ? withAlpha(status, tokens.dark ? 0.16 : 0.12) : tokens.surface3,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ fontSize: ui(12), color: status ?? colors.foregroundMuted }}>{label}</Text>
    </View>
  );
}

/** Paseo's Switch: 34x20 track (surface3 / accent), 16pt thumb, in a 32-high control slot. */
export function Switch({ colors, value, onValueChange, label, disabled }: { colors: Colors; value: boolean; onValueChange(value: boolean): void; label: string; disabled?: boolean }) {
  const tokens = nativeTokens(colors);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      disabled={disabled}
      hitSlop={8}
      // Inside a pressable row: keep the row's own press from firing (providers-section.tsx).
      onPressIn={(event) => event.stopPropagation()}
      onPress={() => onValueChange(!value)}
      style={{ minHeight: 32, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ width: 34, height: 20, borderRadius: 10, padding: 2, justifyContent: "center", backgroundColor: value ? colors.accent : tokens.surface3 }}>
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: value ? colors.accentForeground : "#ffffff",
            transform: [{ translateX: value ? 14 : 0 }],
            shadowColor: "rgba(0, 0, 0, 0.25)",
            shadowOffset: { width: 0, height: 1 },
            shadowRadius: 2,
            shadowOpacity: 1,
            elevation: 2,
          }}
        />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- rows

/** Title + hint + optional error, with settingsStyles.rowTitle/rowHint/rowError. */
export function RowText({ colors, label, hint, error, hintLines }: { colors: Colors; label: string; hint?: string | null; error?: string | null; hintLines?: number }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foreground }}>
        {label}
      </Text>
      {hint ? (
        <Text numberOfLines={hintLines} style={{ fontSize: ui(12), color: colors.foregroundMuted, marginTop: 4 }}>
          {hint}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger, marginTop: 4 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A whole-row Pressable inside a SettingsCard (16/16 padding), highlighted surface2 on hover
 * and surface3 while pressed, like Paseo's schedule rows. Render it as a direct card child
 * so the card draws the divider.
 */
export function PressableRow({ colors, onPress, accessibilityLabel, children }: { colors: Colors; onPress(): void; accessibilityLabel: string; children: (state: { hovered: boolean }) => ReactNode }) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: pressed ? tokens.surface3 : hovered && isWeb ? colors.surface2 : "transparent",
      })}
    >
      {children({ hovered })}
    </Pressable>
  );
}

/** A row that drills into a detail: whole row pressable, ChevronRight 14 in the trailing slot. */
export function DrillRow({ colors, label, hint, error, trailing, onPress, hintLines = 1 }: { colors: Colors; label: string; hint?: string | null; error?: string | null; trailing?: ReactNode; onPress(): void; hintLines?: number }) {
  return (
    <PressableRow colors={colors} onPress={onPress} accessibilityLabel={label}>
      {({ hovered }) => (
        <>
          <RowText colors={colors} label={label} hint={hint} error={error} hintLines={hintLines} />
          {trailing}
          <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
        </>
      )}
    </PressableRow>
  );
}

/** A card row whose control needs the full width under its label (e.g. colour swatches). */
export function StackedRow({ colors, label, hint, children }: { colors: Colors; label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      <RowText colors={colors} label={label} hint={hint} />
      {children}
    </View>
  );
}

/** Empty or loading state inside a card: 16 padding, centered, muted 14. */
export function CardNote({ colors, text, loading }: { colors: Colors; text: string; loading?: boolean }) {
  return (
    <View style={{ padding: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }}>
      {loading ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- triggers

/** Paseo's row kebab (MoreVertical 14, padding 4, radius 4, hover surface2, hitSlop 8). */
export function KebabButton({ colors, label, onOpen }: { colors: Colors; label: string; onOpen(anchor: LayoutRectangle): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPressIn={(event) => event.stopPropagation()}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onOpen(anchor))}
      {...hoverProps}
      style={{ padding: 4, borderRadius: 4, backgroundColor: hovered ? colors.surface2 : "transparent" }}
    >
      <Icon name="MoreVertical" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

/** A section header's trailing action (settingsStyles.sectionHeaderLink: muted 12, gap 4). */
export function SectionLink({ colors, label, icon = "Plus", onPress }: { colors: Colors; label: string; icon?: string; onPress(anchor: LayoutRectangle | null): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  const tint = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => void measureAnchor(ref).then(onPress)}
      {...hoverProps}
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      <Icon name={icon} size={12} color={tint} />
      <Text style={{ fontSize: ui(12), color: tint }}>{label}</Text>
    </Pressable>
  );
}

/** Muted 12pt text for a section header's trailing slot (counters, totals). */
export function SectionMeta({ colors, text, tone }: { colors: Colors; text: string; tone?: "warning" | "danger" }) {
  const color = tone === "danger" ? colors.statusDanger : tone === "warning" ? colors.statusWarning : colors.foregroundMuted;
  return <Text style={{ fontSize: ui(12), color }}>{text}</Text>;
}
