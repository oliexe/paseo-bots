// The message queue outlives a mounted composer. Its user-stop state must too.
const paused = new Set<string>();
const listeners = new Set<() => void>();

export function isQueuePaused(key: string): boolean { return paused.has(key); }
export function setQueuePaused(key: string, value: boolean): void {
  if (paused.has(key) === value) return;
  if (value) paused.add(key); else paused.delete(key);
  for (const listener of listeners) listener();
}
export function subscribeQueuePause(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
