import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View, type LayoutRectangle } from "react-native";
import { nativeTokens, useHover } from "../native";
import { ui } from "../typography";

// Paseo's DropdownMenu (components/ui/menu): an anchored popover on desktop and a
// bottom sheet on compact. Plugins get no menu component inside a surface, so this
// reproduces its geometry: rows 28 high (40 on compact), inset 4 with 8 padding and
// radius 6, a 16pt leading slot with a 14pt icon, 14pt labels on an 18 line, a
// surface1 card with a borderAccent frame, radius 8 and shadow md.

type Colors = PluginTheme["colors"];

export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      icon?: string;
      /** Replaces the icon, e.g. a team's logo. */
      leading?: ReactNode;
      /** The current choice in a switcher; gets Paseo's trailing check. */
      selected?: boolean;
      destructive?: boolean;
      disabled?: boolean;
      /** Shown on the right, e.g. a shortcut or current value. */
      trailing?: string;
      onSelect(): void | Promise<void>;
      /** Label while `onSelect` is running, e.g. "Archiving...". Keeps the menu open until it finishes. */
      pendingLabel?: string;
    }
  | { kind: "separator" };

export interface MenuSpec {
  /** Window coordinates of the trigger, or of the pointer for context menus. */
  anchor: LayoutRectangle;
  align?: "start" | "end";
  /** Native widths: 220 for project menus, 260 for workspace menus. */
  width?: number;
  /** Sheet title on compact, e.g. "Bot actions". */
  title: string;
  entries: MenuEntry[];
}

interface MenuApi {
  open(spec: MenuSpec): void;
  close(): void;
}

const MenuContext = createContext<MenuApi>({ open: () => {}, close: () => {} });

export function useMenu(): MenuApi {
  return useContext(MenuContext);
}

/** Window rectangle of a view, for anchoring a menu to it. */
export function measureAnchor(ref: RefObject<View | null>): Promise<LayoutRectangle | null> {
  return new Promise((resolve) => {
    const node = ref.current;
    if (!node) return resolve(null);
    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/** Props for a Pressable that opens a context menu on right-click (web and desktop only, like Paseo). */
export function contextMenuProps(onOpen: (anchor: LayoutRectangle) => void): object {
  if (Platform.OS !== "web") return {};
  return {
    onContextMenu: (event: { preventDefault?: () => void; nativeEvent: { clientX?: number; clientY?: number; pageX?: number; pageY?: number } }) => {
      event.preventDefault?.();
      const x = event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0;
      const y = event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0;
      onOpen({ x, y, width: 0, height: 0 });
    },
  };
}

// This plugin typechecks without the DOM library. Declare only what this module uses.
const dom = globalThis as unknown as {
  addEventListener?: (type: "keydown", listener: (event: { key: string; stopPropagation(): void }) => void, capture?: boolean) => void;
  removeEventListener?: (type: "keydown", listener: (event: { key: string; stopPropagation(): void }) => void, capture?: boolean) => void;
};

export function MenuProvider({ colors, compact, children }: { colors: Colors; compact: boolean; children: ReactNode }) {
  const [spec, setSpec] = useState<MenuSpec | null>(null);
  const [origin, setOrigin] = useState<LayoutRectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const root = useRef<View>(null);
  const close = useCallback(() => setSpec(null), []);
  const open = useCallback((next: MenuSpec) => {
    void measureAnchor(root).then((rect) => {
      if (rect) setOrigin(rect);
      setSpec(next);
    });
  }, []);
  const api = useMemo(() => ({ open, close }), [open, close]);

  useEffect(() => {
    if (!spec || Platform.OS !== "web" || !dom.addEventListener) return;
    // Capture phase: Paseo's own shortcut handling would otherwise swallow Escape first.
    const onKey = (event: { key: string; stopPropagation(): void }) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener?.("keydown", onKey, true);
  }, [spec, close]);

  return (
    <MenuContext.Provider value={api}>
      <View ref={root} collapsable={false} style={{ flex: 1 }}>
        {children}
        {spec && !compact ? <Popover colors={colors} spec={spec} origin={origin} onClose={close} /> : null}
      </View>
      {spec && compact ? (
        <Modal title={spec.title} open onOpenChange={(value) => !value && close()}>
          <Modal.Content contentContainerStyle={{ padding: 8, gap: 0 }}>
            <Entries colors={colors} entries={spec.entries} compact onClose={close} />
          </Modal.Content>
        </Modal>
      ) : null}
    </MenuContext.Provider>
  );
}

function Popover({ colors, spec, origin, onClose }: { colors: Colors; spec: MenuSpec; origin: LayoutRectangle; onClose(): void }) {
  const tokens = nativeTokens(colors);
  const [height, setHeight] = useState(0);
  const width = spec.width ?? 220;
  const anchor = { ...spec.anchor, x: spec.anchor.x - origin.x, y: spec.anchor.y - origin.y };
  const rawLeft = spec.align === "end" ? anchor.x + anchor.width - width : anchor.x;
  const left = Math.max(8, Math.min(rawLeft, origin.width - width - 8));
  const below = anchor.y + anchor.height + 4;
  const top = height && below + height > origin.height - 8 ? Math.max(8, anchor.y - height - 4) : below;
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }}>
      <Pressable accessibilityLabel="Close menu" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View
        accessibilityRole="menu"
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={{
          position: "absolute",
          top,
          left,
          width,
          opacity: height ? 1 : 0,
          paddingVertical: 4,
          backgroundColor: colors.surface1,
          borderWidth: 1,
          borderColor: tokens.borderAccent,
          borderRadius: 8,
          overflow: "hidden",
          shadowColor: tokens.dark ? "rgba(0, 0, 0, 0.20)" : "rgba(0, 0, 0, 0.04)",
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: tokens.dark ? 8 : 16,
          elevation: 8,
        }}
      >
        <Entries colors={colors} entries={spec.entries} compact={false} onClose={onClose} />
      </View>
    </View>
  );
}

function Entries({ colors, entries, compact, onClose }: { colors: Colors; entries: MenuEntry[]; compact: boolean; onClose(): void }) {
  const tokens = nativeTokens(colors);
  return (
    <>
      {entries.map((entry, index) =>
        entry.kind === "separator" ? (
          <View key={`sep-${index}`} style={{ height: 1, marginVertical: 4, backgroundColor: tokens.borderAccent }} />
        ) : (
          <MenuRow key={`${entry.label}-${index}`} colors={colors} entry={entry} compact={compact} onClose={onClose} />
        ),
      )}
    </>
  );
}

function MenuRow({ colors, entry, compact, onClose }: { colors: Colors; entry: Exclude<MenuEntry, { kind: "separator" }>; compact: boolean; onClose(): void }) {
  const { hovered, hoverProps } = useHover();
  const [pending, setPending] = useState(false);
  const tint = entry.destructive ? colors.statusDanger : colors.foreground;
  const select = () => {
    const result = entry.onSelect();
    if (entry.pendingLabel && result && typeof (result as Promise<void>).then === "function") {
      setPending(true);
      void (result as Promise<void>).finally(() => {
        setPending(false);
        onClose();
      });
    } else onClose();
  };
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={entry.label}
      accessibilityState={{ disabled: !!entry.disabled || pending, selected: entry.selected }}
      disabled={entry.disabled || pending}
      onPress={select}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 40 : 28,
        marginHorizontal: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: "transparent",
        borderRadius: 6,
        backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        opacity: entry.disabled ? 0.5 : 1,
      })}
    >
      {entry.icon || entry.leading || pending ? (
        <View style={{ width: 16, alignItems: "center", justifyContent: "center" }}>
          {pending ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : (entry.leading ?? <Icon name={entry.icon!} size={14} color={entry.destructive ? colors.statusDanger : colors.foregroundMuted} />)}
        </View>
      ) : null}
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), lineHeight: 18, color: tint }}>
        {pending && entry.pendingLabel ? entry.pendingLabel : entry.label}
      </Text>
      {entry.trailing ? <Text style={{ marginLeft: "auto", fontSize: ui(12), color: colors.foregroundMuted }}>{entry.trailing}</Text> : null}
      {entry.selected ? (
        <View style={{ marginLeft: "auto", width: 16, alignItems: "center", justifyContent: "center" }}>
          <Icon name="Check" size={16} color={colors.foregroundMuted} />
        </View>
      ) : null}
    </Pressable>
  );
}
