import type { LibraryKind } from "../shared/library";

// Skills & Tools lives inside the Bots screen. A bot's settings and the bot
// list ask for it here, optionally for one item, and the Bots screen switches
// to it. Paseo can keep more than one Bots screen mounted, so every listener
// gets the target instead of the first one taking it.

/** The library item to show: a skill, an MCP server, a connected app (by slug), or the app catalog. */
export type LibraryTarget = { kind: LibraryKind | "app"; id: string } | { kind: "apps" };

type Listener = (target: LibraryTarget | null) => void;
const listeners = new Set<Listener>();

export function openLibrary(target: LibraryTarget | null = null): void {
  for (const listener of listeners) listener(target);
}

export function onLibraryTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
