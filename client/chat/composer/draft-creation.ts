interface DraftActivity {
  creating: boolean;
  attachments: number;
  revision: number;
  listeners: Set<() => void>;
}

// A route can unmount while a first send or attachment read is still pending.
// Its work belongs to this installation and draft, not to its composer mount.
const stores = new WeakMap<object, Map<string, DraftActivity>>();

function activity(store: object, key: string): DraftActivity {
  let drafts = stores.get(store);
  if (!drafts) { drafts = new Map(); stores.set(store, drafts); }
  let state = drafts.get(key);
  if (!state) {
    state = { creating: false, attachments: 0, revision: 0, listeners: new Set() };
    drafts.set(key, state);
  }
  return state;
}

function emit(state: DraftActivity): void {
  for (const listener of state.listeners) listener();
}

export function isDraftCreationPending(store: object, key: string): boolean {
  return stores.get(store)?.get(key)?.creating ?? false;
}

export function isDraftAttachmentPending(store: object, key: string): boolean {
  return (stores.get(store)?.get(key)?.attachments ?? 0) > 0;
}

export function subscribeDraftCreation(store: object, key: string, listener: () => void): () => void {
  const state = activity(store, key);
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

/** Acquire before the first await; release in finally, even if creation fails. */
export function beginDraftCreation(store: object, key: string): () => void {
  const state = activity(store, key);
  if (state.creating) throw new Error("This chat is still being created. Your next message is saved in the draft.");
  if (state.attachments) throw new Error("Wait for the attachments to finish before sending.");
  state.creating = true;
  state.revision++;
  emit(state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.creating = false;
    emit(state);
  };
}

/** Accepted files finish normally; another mount cannot send ahead of them. */
export function beginDraftAttachments(store: object, key: string): () => void {
  const state = activity(store, key);
  if (state.creating) throw new Error("Wait for the new chat to open before adding attachments.");
  state.attachments++;
  emit(state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.attachments--;
    emit(state);
  };
}

/** A picker opened before Send must not attach to its old draft afterward. */
export function draftCreationGuard(store: object, key: string): () => boolean {
  const state = activity(store, key);
  const revision = state.revision;
  const wasIdle = !state.creating;
  return () => wasIdle && !state.creating && state.revision === revision;
}
