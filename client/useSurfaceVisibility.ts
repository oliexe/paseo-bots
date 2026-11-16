import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type View } from "react-native";
import { observeSurfaceVisibility, surfaceIsVisible } from "./web";

const appActive = () => AppState.currentState == null || AppState.currentState === "active";

/** Public View refs on web expose layout presence; native also follows app backgrounding. */
export function useSurfaceVisibility() {
  const node = useRef<View | null>(null);
  const [element, setElement] = useState<View | null>(null);
  const [visible, setVisible] = useState(false);
  const ref = useCallback((next: View | null) => { node.current = next; setElement(next); }, []);
  const isVisible = useCallback(() => appActive() && surfaceIsVisible(node.current), []);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    update();
    const stopObserving = observeSurfaceVisibility(element, update);
    const app = AppState.addEventListener("change", update);
    return () => { stopObserving(); app.remove(); };
  }, [element, isVisible]);
  return { ref, visible, isVisible };
}
