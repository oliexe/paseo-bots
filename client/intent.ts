// Command Center items can open the surface but can't pass it arguments.
// They leave an intent here; the surface consumes it when it mounts.

export type SurfaceIntent = { kind: "new-bot" };

let pending: SurfaceIntent | null = null;

export function requestIntent(intent: SurfaceIntent): void {
  pending = intent;
}

export function takeIntent(): SurfaceIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}
