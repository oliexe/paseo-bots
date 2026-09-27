import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { ComposerAttachment } from "../../../shared/attachments";
import { enqueue, isDraftEmpty, parseDrafts, serializeDrafts, takeQueued, type ComposerDraft, type QueuedMessage } from "./logic";
import { readItem, readItemSync, writeItem } from "./storage";

// ---------------------------------------------------------------- drafts

// Paseo keeps one draft per chat (stores/draft-store) and persists it every 200ms.
const DRAFTS_KEY = "@paseo-bot:composer-drafts";
const PERSIST_INTERVAL_MS = 200;

let drafts: Record<string, ComposerDraft> = Platform.OS === "web" ? parseDrafts(readItemSync(DRAFTS_KEY)) : {};
let loaded = Platform.OS === "web";
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Loads persisted drafts once (phones read AsyncStorage asynchronously; web is already loaded). */
export function loadDrafts(): Promise<void> {
  if (loaded) return Promise.resolve();
  loading ??= readItem(DRAFTS_KEY).then((raw) => {
    // Drafts touched before the load finished win over the stored copies.
    drafts = { ...parseDrafts(raw), ...drafts };
    loaded = true;
  });
  return loading;
}

export function getDraft(key: string): ComposerDraft | null {
  return drafts[key] ?? null;
}

export function setDraft(key: string, draft: { text: string; attachments: ComposerAttachment[] } | null): void {
  const current = drafts[key];
  if (isDraftEmpty(draft)) {
    if (!current) return;
    const { [key]: _removed, ...rest } = drafts;
    drafts = rest;
  } else {
    if (current && current.text === draft!.text && current.attachments === draft!.attachments) return;
    drafts = { ...drafts, [key]: { text: draft!.text, attachments: draft!.attachments, updatedAt: Date.now() } };
  }
  schedulePersist();
}

function schedulePersist(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const write = () => void writeItem(DRAFTS_KEY, serializeDrafts(drafts));
    if (loaded) write();
    else void loadDrafts().then(write);
  }, PERSIST_INTERVAL_MS);
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

export function readQueue(key: string): QueuedMessage[] {
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
