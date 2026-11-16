import { useSyncExternalStore } from "react";
import { appendDraftText, enqueue, takeQueued, type QueuedMessage } from "./logic";
import { useDeviceStorage } from "./storage";
import type { DeviceStore } from "../../device-store";
import { ComposerDraftStore } from "./draft-store";
import { mutateDraft } from "./draft-mutations";
import { isDraftAttachmentPending, isDraftCreationPending, subscribeDraftCreation } from "./draft-creation";
import { isQueuePaused, subscribeQueuePause } from "./queue-pause";

// ---------------------------------------------------------------- drafts

const stores = new WeakMap<DeviceStore, ComposerDraftStore>();
export function useDraftStore(): ComposerDraftStore {
  const storage = useDeviceStorage();
  let store = stores.get(storage);
  if (!store) { store = new ComposerDraftStore(storage); stores.set(storage, store); }
  return store;
}

export function useDraftCreationPending(store: ComposerDraftStore, key: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribeDraftCreation(store, key, listener),
    () => isDraftCreationPending(store, key),
    () => isDraftCreationPending(store, key),
  );
}

export function useDraftAttachmentPending(store: ComposerDraftStore, key: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribeDraftCreation(store, key, listener),
    () => isDraftAttachmentPending(store, key),
    () => isDraftAttachmentPending(store, key),
  );
}

export async function insertDraftText(store: ComposerDraftStore, key: string, text: string): Promise<void> {
  if (!text.trim()) return;
  await mutateDraft(store, key, (current) => ({ ...current, text: appendDraftText(current.text, text) }), { focus: true });
}

// ---------------------------------------------------------------- queue

// Queued messages live for the session, per chat, like Paseo's session-store queue.
const queues = new Map<string, QueuedMessage[]>();
const listeners = new Set<() => void>();
const EMPTY: QueuedMessage[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readQueue(key: string): QueuedMessage[] {
  return queues.get(key) ?? EMPTY;
}

function writeQueue(key: string, next: QueuedMessage[]): void {
  if (next.length === 0) queues.delete(key);
  else queues.set(key, next);
  emit();
}

export function queueMessage(key: string, message: QueuedMessage): void {
  writeQueue(key, enqueue(readQueue(key), message));
}

export function takeQueuedMessage(key: string, id: string): QueuedMessage | null {
  const { item, rest } = takeQueued(readQueue(key), id);
  if (item) writeQueue(key, rest);
  return item;
}

/** Puts a message back at the front after a failed send. */
export function requeueFront(key: string, message: QueuedMessage): void {
  writeQueue(key, [message, ...readQueue(key).filter((entry) => entry.id !== message.id)]);
}

export function useQueue(key: string): QueuedMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => readQueue(key),
    () => readQueue(key),
  );
}

export function useQueuePaused(key: string): boolean {
  return useSyncExternalStore(subscribeQueuePause, () => isQueuePaused(key), () => isQueuePaused(key));
}
