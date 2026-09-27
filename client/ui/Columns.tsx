import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Dimensions, Easing, PanResponder, Platform, View } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
type PointerListener = (event: { clientX: number }) => void;
const win = globalThis as unknown as {
  addEventListener?: (type: "pointermove" | "pointerup" | "pointercancel", listener: PointerListener) => void;
  removeEventListener?: (type: "pointermove" | "pointerup" | "pointercancel", listener: PointerListener) => void;
};

/**
 * Drag handle on a column edge, like Paseo's sidebar/explorer resize handles
 * (10px wide, col-resize cursor). Web and desktop only; phones don't resize columns.
 * A drag starts only with a pointer-down on the handle itself and follows window
 * pointer events until release, so no other gesture can resize a column.
 */
export function ResizeHandle({ side, width, onResize, onCommit }: { side: "left" | "right"; width: number; onResize(width: number): void; onCommit(width: number): void }) {
  const latest = useRef(width);
  latest.current = width;
  const onResizeRef = useRef(onResize);
  const onCommitRef = useRef(onCommit);
  onResizeRef.current = onResize;
  onCommitRef.current = onCommit;
  if (Platform.OS !== "web" || !win.addEventListener) return null;

  const begin = (event: { nativeEvent: { clientX?: number; pageX?: number } }) => {
    const startX = event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0;
    const startWidth = latest.current;
    let moved = false;
    const move: PointerListener = (next) => {
      const dx = next.clientX - startX;
      if (dx !== 0) moved = true;
      onResizeRef.current(startWidth + (side === "right" ? dx : -dx));
    };
    const end: PointerListener = () => {
      win.removeEventListener?.("pointermove", move);
      win.removeEventListener?.("pointerup", end);
      win.removeEventListener?.("pointercancel", end);
      if (moved) onCommitRef.current(latest.current);
    };
    win.addEventListener?.("pointermove", move);
    win.addEventListener?.("pointerup", end);
    win.addEventListener?.("pointercancel", end);
  };

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Resize"
      onPointerDown={begin}
      style={[{ position: "absolute", top: 0, bottom: 0, width: 10, zIndex: 10, [side]: -5 }, { cursor: "col-resize" } as object]}
    />
  );
}

const native = Platform.OS !== "web";

/** Open slide-overs, innermost last: only the top one answers a swipe. */
const layers: object[] = [];

/**
 * A full-width level sliding in from the right on phones over the level it came from,
 * like Paseo's mobile panels (mobile-panels/presentation.tsx). Swiping right follows the
 * finger with Paseo's rules (gestures.ts, gesture-intent.ts): 15pt of mostly-horizontal
 * travel starts it, a third of the width or 500pt/s finishes it. The top level claims the
 * swipe before its buttons can, so it works from anywhere on the level. A finished swipe
 * steps back inside the level when `onBack` handles it (a settings page back to the
 * list), otherwise the level slides away and closes.
 */
export function SlideOver({ onClose, onBack, children }: { onClose(): void; onBack?: () => boolean; children: ReactNode }) {
  const width = Dimensions.get("window").width;
  const offset = useRef(new Animated.Value(width)).current;
  const [closing, setClosing] = useState(false);
  const handlers = useRef({ onClose, onBack });
  handlers.current = { onClose, onBack };
  const layer = useRef({}).current;

  useEffect(() => {
    layers.push(layer);
    Animated.timing(offset, { toValue: 0, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
    return () => void layers.splice(layers.indexOf(layer), 1);
  }, [offset, layer]);

  const settle = () => Animated.spring(offset, { toValue: 0, useNativeDriver: native, bounciness: 0 }).start();
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    Animated.timing(offset, { toValue: width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: native }).start(() => handlers.current.onClose());
  };
  const finish = useRef(dismiss);
  finish.current = () => {
    if (handlers.current.onBack?.()) settle();
    else dismiss();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) => layers[layers.length - 1] === layer && gesture.dx >= 15 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_event, gesture) => offset.setValue(Math.max(0, gesture.dx)),
      onPanResponderRelease: (_event, gesture) => (gesture.dx > width / 3 || gesture.vx > 0.5 ? finish.current() : settle()),
      onPanResponderTerminate: settle,
    }),
  ).current;

  return (
    <Animated.View {...responder.panHandlers} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, transform: [{ translateX: offset }] }}>
      {children}
    </Animated.View>
  );
}
