// Command Center items can open the surface but can't pass it arguments.
// They leave an intent here; the surface consumes it on mount or when notified.

export type SurfaceIntent = { kind: "new-bot" };

let pending: SurfaceIntent | null = null;
const listeners = new Set<() => void>();

export function requestIntent(intent: SurfaceIntent): void {
  pending = intent;
  for (const listener of listeners) listener();
}

export function takeIntent(): SurfaceIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

export function onIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
