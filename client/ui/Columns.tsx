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

/**
 * Full-width panel sliding in from the right on phones, closed by swiping right,
 * like Paseo's mobile explorer overlay (mobile-panels/presentation.tsx, gestures.ts:
 * close past a third of the width or a flick faster than 500pt/s).
 */
export function SlideOver({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const width = Dimensions.get("window").width;
  const offset = useRef(new Animated.Value(width)).current;
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    Animated.timing(offset, { toValue: 0, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
  }, [offset]);

  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    Animated.timing(offset, { toValue: width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start(() => onCloseRef.current());
  };

  const responder = useRef(
    PanResponder.create({
      // Only claim clearly horizontal right swipes so vertical scrolling keeps working.
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
      onPanResponderMove: (_event, gesture) => offset.setValue(Math.max(0, gesture.dx)),
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx > width / 3 || gesture.vx > 0.5) dismissRef.current();
        else Animated.spring(offset, { toValue: 0, useNativeDriver: Platform.OS !== "web", bounciness: 0 }).start();
      },
      onPanResponderTerminate: () => Animated.spring(offset, { toValue: 0, useNativeDriver: Platform.OS !== "web", bounciness: 0 }).start(),
    }),
  ).current;
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  return (
    <Animated.View {...responder.panHandlers} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, transform: [{ translateX: offset }] }}>
      {children}
    </Animated.View>
  );
}
