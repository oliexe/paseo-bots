import type { ComposerAttachment } from "../../../shared/attachments";
import type { DraftStorage } from "../../device-store";
import { isDraftEmpty, parseDrafts, serializeDrafts, type ComposerDraft } from "./logic";

const DRAFTS_KEY = "@paseo-bots:composer-drafts";

/** Durable drafts with explicit pre-hydration deletions. */
export class ComposerDraftStore {
  private drafts: Record<string, ComposerDraft>;
  private touched = new Set<string>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly storage: DraftStorage) {
    this.drafts = parseDrafts(storage.readItemSync(DRAFTS_KEY));
    storage.subscribe(() => { if (!this.loaded) void this.load().catch(() => {}); });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.storage.readItem(DRAFTS_KEY).then((raw) => {
      const stored = parseDrafts(raw);
      for (const key of this.touched) {
        const draft = this.drafts[key];
        if (draft) stored[key] = draft;
        else delete stored[key];
      }
      this.drafts = stored;
      this.loaded = true;
      for (const listener of this.listeners) listener();
      if (this.touched.size) this.schedulePersist();
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  get(key: string): ComposerDraft | null { return this.drafts[key] ?? null; }

  set(key: string, draft: { text: string; attachments: ComposerAttachment[] } | null): void {
    // Deleting a not-yet-loaded draft must leave a tombstone for hydration.
    this.touched.add(key);
    if (isDraftEmpty(draft)) delete this.drafts[key];
    else this.drafts[key] = { text: draft!.text, attachments: draft!.attachments, updatedAt: Date.now() };
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {}); }, 200);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      await this.load();
      const json = serializeDrafts(this.drafts);
      const bounded = parseDrafts(json);
      if (Object.entries(bounded).some(([key, draft]) => draft.text !== this.drafts[key]?.text)) {
        throw new Error("This draft is too large to save. Its full text is still here; shorten it or send it before leaving.");
      }
      await this.storage.writeItem(DRAFTS_KEY, json);
    } catch (error) {
      this.storage.reportError?.(error);
      throw error;
    }
  }
}
