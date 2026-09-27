import type { LibraryKind } from "../shared/library";

// Skills & Tools lives inside the Bots screen. A bot's settings and the bot
// list ask for it here, optionally for one item, and the Bots screen switches to it.

/** The library item to show. */
export type LibraryTarget = { kind: LibraryKind; id: string };

let pending: LibraryTarget | null = null;
const listeners = new Set<() => void>();

export function openLibrary(target: LibraryTarget | null = null): void {
  pending = target;
  for (const listener of listeners) listener();
}

export function takeLibraryTarget(): LibraryTarget | null {
  const target = pending;
  pending = null;
  return target;
}

export function onLibraryTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
