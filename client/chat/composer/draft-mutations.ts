import type { ComposerDraftStore } from "./draft-store";
import type { ComposerDraft } from "./logic";

export type DraftContent = Pick<ComposerDraft, "text" | "attachments">;
type DraftMutationStore = Pick<ComposerDraftStore, "load" | "get" | "set">;

interface DraftTarget {
  isActive(): boolean;
  read(): DraftContent;
  apply(draft: DraftContent, focus: boolean): void;
}

// Expo may retain hidden routes. Only copies of this installation's exact draft
// key participate, and the visible copy owns any keystrokes not yet persisted.
const targets = new WeakMap<DraftMutationStore, Map<string, Set<DraftTarget>>>();

export function listenForDraftMutation(store: DraftMutationStore, key: string, target: DraftTarget): () => void {
  let byKey = targets.get(store);
  if (!byKey) { byKey = new Map(); targets.set(store, byKey); }
  let listeners = byKey.get(key);
  if (!listeners) { listeners = new Set(); byKey.set(key, listeners); }
  listeners.add(target);
  return () => {
    listeners.delete(target);
    if (!listeners.size && byKey.get(key) === listeners) byKey.delete(key);
  };
}

function activeTarget(store: DraftMutationStore, key: string): DraftTarget | undefined {
  // Prefer the most recently mounted visible composer if a route transition
  // briefly leaves both copies laid out.
  return [...targets.get(store)?.get(key) ?? []].reverse().find((target) => target.isActive());
}

/** Merge late async work into current typing without returning focus to an old tab. */
export async function mutateDraft(store: DraftMutationStore, key: string, mutate: (current: DraftContent) => DraftContent, options: { focus?: boolean } = {}): Promise<void> {
  let owner = activeTarget(store, key);
  if (!owner) {
    await store.load();
    // A composer may have mounted while storage was loading.
    owner = activeTarget(store, key);
  }
  const current = owner?.read() ?? store.get(key) ?? { text: "", attachments: [] };
  const next = mutate({ text: current.text, attachments: current.attachments });
  store.set(key, next);
  for (const target of targets.get(store)?.get(key) ?? []) target.apply(next, target === owner && options.focus === true);
}
