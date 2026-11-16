import type { DeviceStorageValues } from "../shared/device-storage";

type Item = DeviceStorageValues["items"][string];
export type DeviceSettingsSnapshot = ({ status: "ready"; revision: string; values: DeviceStorageValues } | { status: "loading" | "error" | "invalid" }) & {
  save(values: DeviceStorageValues, revision: string): Promise<boolean>;
  reload(): Promise<void>;
};

export interface DraftStorage {
  readItem(key: string): Promise<string | null>;
  readItemSync(key: string): string | null;
  writeItem(key: string, value: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  reportError?(error: unknown): void;
}

/** One optimistic write queue per installation, shared by its mounted surfaces. */
export class DeviceStore implements DraftStorage {
  private state: DeviceSettingsSnapshot | null = null;
  private revision: string | null = null;
  private values: Record<string, Item> = {};
  private dirty = new Map<string, Item>();
  private listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;
  private blockedRevision: string | null = null;
  private error: string | null = null;
  private reportedError: string | null = null;

  constructor(private readonly legacyRead: (key: string) => string | null = () => null) {}

  update(state: DeviceSettingsSnapshot): void {
    this.state = state;
    if (state.status === "ready" && state.revision !== this.revision) {
      this.revision = state.revision;
      this.blockedRevision = null;
      this.values = { ...state.values.items, ...Object.fromEntries(this.dirty) };
      for (const listener of this.listeners) listener();
    }
    if (state.status === "ready" && this.dirty.size && this.blockedRevision !== state.revision) void this.flush().catch(() => {});
  }

  takeError(): string | null {
    if (this.error === this.reportedError) return null;
    this.reportedError = this.error;
    return this.error;
  }

  reportError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  readItemSync(key: string): string | null {
    return this.values[key]?.value ?? (this.revision === null ? this.legacyRead(key) : null);
  }

  async readItem(key: string): Promise<string | null> {
    if (this.revision === null) {
      await new Promise<void>((resolve, reject) => {
        let remove = () => {};
        const timeout = setTimeout(() => { remove(); reject(new Error("Draft storage is still loading. Your current edits remain in this session.")); }, 5000);
        const check = () => {
          if (this.revision === null) return;
          clearTimeout(timeout); remove(); resolve();
        };
        remove = this.subscribe(check);
        check();
      });
    }
    const saved = this.values[key];
    if (saved) return saved.value;
    // Migrate only this plugin's former web storage; never inspect Paseo's private settings.
    const legacy = this.legacyRead(key);
    if (legacy !== null) void this.writeItem(key, legacy).catch(() => {});
    return legacy;
  }

  writeItem(key: string, value: string): Promise<void> {
    if (key.length > 500 || value.length > 2_100_000) return Promise.reject(new Error("This draft is too large to save on the device."));
    const item = { value, updatedAt: Date.now() };
    this.values[key] = item;
    this.dirty.set(key, item);
    this.blockedRevision = null;
    return this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = async () => {
      for (let attempt = 0; attempt < 3 && this.dirty.size; attempt++) {
        const state = this.state;
        if (state?.status !== "ready") return;
        const changes = new Map(this.dirty);
        const items = { ...state.values.items, ...Object.fromEntries(changes) };
        const newest = Object.entries(items).sort((a, b) => Number(changes.has(b[0])) - Number(changes.has(a[0])) || b[1].updatedAt - a[1].updatedAt);
        let bytes = 0;
        const bounded: Record<string, Item> = {};
        for (const [key, item] of newest) {
          // Four bytes per UTF-16 code unit is a conservative bound on encoded JSON.
          const size = JSON.stringify([key, item]).length * 4;
          if (Object.keys(bounded).length >= 100 || bytes + size > 12_000_000) {
            if (changes.has(key)) throw new Error("Your unfinished drafts exceed device storage limits. Shorten a draft or remove large attachments before saving.");
            continue;
          }
          bytes += size;
          bounded[key] = item;
        }
        if (await state.save({ items: bounded }, state.revision)) {
          for (const [key, item] of changes) if (this.dirty.get(key) === item) this.dirty.delete(key);
          this.error = null;
          this.reportedError = null;
          if (!this.dirty.size) return;
        }
        await state.reload();
        // The public hook publishes the freshly loaded revision on the next render.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (this.dirty.size && this.state?.status === "ready") throw new Error("Couldn't save drafts on this device. Your edits remain in this session; edit again to retry.");
    };
    // Install the in-flight promise before save can synchronously publish a revision.
    this.flushing = Promise.resolve().then(run).catch((error: unknown) => {
      if (this.state?.status === "ready") this.blockedRevision = this.state.revision;
      this.reportError(error);
      throw error;
    }).finally(() => {
      this.flushing = null;
      if (this.dirty.size && this.state?.status === "ready" && this.blockedRevision !== this.state.revision) void this.flush().catch(() => {});
    });
    return this.flushing;
  }
}
