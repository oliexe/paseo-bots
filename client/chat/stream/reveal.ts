import { useEffect, useRef, useState } from "react";

const STEP_MS = 32;
/** Each step reveals this fraction of the text still hidden, and at least one character. */
const CATCH_UP = 8;

/**
 * Paces streamed text the way Paseo's assistant rows do: while a message streams, its text
 * comes into view a few characters per step, faster the further it lags behind, and a complete
 * message shows at once. The SDK's own useRevealedText is deprecated in favour of StreamedText,
 * which draws plain text; the rows here render the paced text as Markdown, so the pacing lives here.
 */
export function useRevealedText(text: string, phase: "streaming" | "complete"): string {
  const [shown, setShown] = useState(() => (phase === "complete" ? text.length : 0));
  const shownRef = useRef(shown);
  useEffect(() => {
    if (phase === "complete") {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    // A message that was replaced by a shorter one shows what still fits.
    if (shownRef.current > text.length) {
      shownRef.current = text.length;
      setShown(text.length);
    }
    if (shownRef.current === text.length) return;
    const timer = setInterval(() => {
      const remaining = text.length - shownRef.current;
      shownRef.current = Math.min(text.length, shownRef.current + Math.max(1, Math.ceil(remaining / CATCH_UP)));
      setShown(shownRef.current);
      if (shownRef.current >= text.length) clearInterval(timer);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [text, phase]);
  return phase === "complete" ? text : text.slice(0, shown);
}
