import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Platform, type TextStyle } from "react-native";
import { createTextMeasurer, domNode, observeWidth, type TextMeasurer } from "../../web";
import { clampHeight } from "./logic";

const web = Platform.OS === "web";

/**
 * Paseo's composer height (composer/input/height.web.ts / height.native.ts): on web the
 * textarea is sized to its measured content between min and max and only scrolls once it
 * hits max; on phones the native input grows by itself within the same bounds.
 */
export function useInputHeight(
  inputRef: RefObject<unknown>,
  text: string,
  minHeight: number,
  maxHeight: number,
  fontSize: number,
): { style: TextStyle; scrollEnabled: boolean } {
  const [height, setHeight] = useState(minHeight);
  const measurer = useRef<TextMeasurer | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const measure = useCallback(() => {
    const measured = measurer.current?.measure(domNode(inputRef.current), textRef.current);
    if (measured === null || measured === undefined) return;
    const next = clampHeight(measured, minHeight, maxHeight);
    setHeight((current) => (Math.abs(current - next) < 1 ? current : next));
  }, [inputRef, minHeight, maxHeight]);

  useEffect(() => {
    if (!web) return;
    measurer.current = createTextMeasurer();
    measure();
    return () => {
      measurer.current?.dispose();
      measurer.current = null;
    };
    // The mirror lives as long as the input.
  }, []);

  useLayoutEffect(() => {
    if (web) measure();
  }, [text, fontSize, measure]);

  useEffect(() => (web ? observeWidth(domNode(inputRef.current), measure) : undefined), [inputRef, measure]);

  if (!web) return { style: { minHeight, maxHeight }, scrollEnabled: true };
  return { style: { height, minHeight, maxHeight }, scrollEnabled: height >= maxHeight };
}
