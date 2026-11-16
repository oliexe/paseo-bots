import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForDraftMutation, mutateDraft, type DraftContent } from "../client/chat/composer/draft-mutations";
import { appendDraftText, restoreFailedSend, type ComposerDraft } from "../client/chat/composer/logic";
import type { ComposerAttachment } from "../shared/attachments";

const note = (id: string): ComposerAttachment => ({ kind: "text", id, name: `${id}.txt`, text: id, size: 1 });
const content = (text: string, attachments: ComposerAttachment[] = []): DraftContent => ({ text, attachments });
const removers: (() => void)[] = [];
afterEach(() => { for (const remove of removers.splice(0)) remove(); });

function memory(initial: Record<string, DraftContent> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    load: vi.fn(async () => {}),
    get: (key: string): ComposerDraft | null => values.has(key) ? { ...values.get(key)!, updatedAt: 1 } : null,
    set: vi.fn((key: string, value: DraftContent | null) => { if (value) values.set(key, value); else values.delete(key); }),
    values,
  };
}

function mounted(store: ReturnType<typeof memory>, key: string, initial: DraftContent, active = true) {
  let current = initial;
  const apply = vi.fn((next: DraftContent, _focus: boolean) => { current = next; });
  const remove = listenForDraftMutation(store, key, { isActive: () => active, read: () => current, apply });
  removers.push(remove);
  return { current: () => current, apply, remove };
}

describe("draft mutations across tab switches", () => {
  it("restores a failed send around newer unpersisted typing without focusing", async () => {
    const store = memory({ chat: content("old") });
    const target = mounted(store, "chat", content("new typing", [note("new")]));
    const failed = content("failed message", [note("failed")]);
    await mutateDraft(store, "chat", (current) => restoreFailedSend(failed, current));
    expect(target.current()).toEqual(content("failed message\nnew typing", [note("failed"), note("new")]));
    expect(target.apply).toHaveBeenCalledWith(target.current(), false);
    expect(store.values.get("chat")).toEqual(target.current());
    expect(store.load).not.toHaveBeenCalled();
  });

  it("appends a late upload to a reopened composer rather than its old owner's contents", async () => {
    const store = memory();
    const old = mounted(store, "chat", content("old", [note("old")]));
    old.remove();
    const current = mounted(store, "chat", content("keep this", [note("current")]));
    old.remove(); // A repeated cleanup must not unregister the replacement.
    await mutateDraft(store, "chat", (draft) => ({ ...draft, attachments: [...draft.attachments, note("upload")] }));
    expect(current.current()).toEqual(content("keep this", [note("current"), note("upload")]));
    expect(old.apply).not.toHaveBeenCalled();
    expect(current.apply).toHaveBeenCalledWith(current.current(), false);
  });

  it("hydrates and uses the freshest stored draft when no composer is visible", async () => {
    const store = memory({ chat: content("stale") });
    const hidden = mounted(store, "chat", content("old route"), false);
    store.load = vi.fn(async () => { store.values.set("chat", content("saved newer", [note("keep")])); });
    await mutateDraft(store, "chat", (current) => restoreFailedSend(content("failed"), current));
    expect(store.values.get("chat")).toEqual(content("failed\nsaved newer", [note("keep")]));
    expect(hidden.current()).toEqual(store.values.get("chat"));
    expect(hidden.apply).toHaveBeenCalledWith(hidden.current(), false);
  });

  it("rechecks ownership after slow hydration to preserve typing in a newly opened tab", async () => {
    const store = memory({ chat: content("stored") });
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    store.load = vi.fn(() => ready);
    const pending = mutateDraft(store, "chat", (current) => restoreFailedSend(content("failed"), current));
    const target = mounted(store, "chat", content("typed while loading"));
    finish();
    await pending;
    expect(target.current().text).toBe("failed\ntyped while loading");
  });

  it("merges concurrent late uploads once each", async () => {
    const store = memory({ chat: content("keep") });
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    store.load = vi.fn(() => ready);
    const append = (attachment: ComposerAttachment) => mutateDraft(store, "chat", (current) => ({ ...current, attachments: [...current.attachments, attachment] }));
    const first = append(note("one"));
    const second = append(note("two"));
    finish();
    await Promise.all([first, second]);
    expect(store.values.get("chat")).toEqual(content("keep", [note("one"), note("two")]));
  });

  it("applies once and synchronizes only this store's exact key", async () => {
    const store = memory();
    const otherStore = memory();
    const hidden = mounted(store, "chat", content("stale hidden"), false);
    const visible = mounted(store, "chat", content("current"));
    const otherKey = mounted(store, "other", content("other key"));
    const otherHost = mounted(otherStore, "chat", content("other installation"));
    const mutate = vi.fn((current: DraftContent) => ({ ...current, text: appendDraftText(current.text, "quote") }));
    await mutateDraft(store, "chat", mutate, { focus: true });
    expect(mutate).toHaveBeenCalledOnce();
    expect(visible.current().text).toBe("current\n\nquote");
    expect(hidden.current()).toEqual(visible.current());
    expect(visible.apply).toHaveBeenCalledWith(visible.current(), true);
    expect(hidden.apply).toHaveBeenCalledWith(hidden.current(), false);
    expect(otherKey.apply).not.toHaveBeenCalled();
    expect(otherHost.apply).not.toHaveBeenCalled();
    expect(otherStore.set).not.toHaveBeenCalled();
  });

  it("prefers the newest visible mounted copy during a transition", async () => {
    const store = memory();
    const first = mounted(store, "chat", content("old"));
    const second = mounted(store, "chat", content("new"));
    await mutateDraft(store, "chat", (current) => ({ ...current, text: appendDraftText(current.text, "addition") }));
    expect(first.current()).toEqual(content("new\n\naddition"));
    expect(second.current()).toEqual(first.current());
  });

  it("does not touch another draft when loading or mutation fails", async () => {
    const store = memory({ chat: content("keep"), other: content("other") });
    store.load = vi.fn(async () => { throw new Error("storage unavailable"); });
    await expect(mutateDraft(store, "chat", () => content("replacement"))).rejects.toThrow("storage unavailable");
    expect(store.set).not.toHaveBeenCalled();
    mounted(store, "chat", content("keep"));
    await expect(mutateDraft(store, "chat", () => { throw new Error("invalid mutation"); })).rejects.toThrow("invalid mutation");
    expect(store.values.get("chat")).toEqual(content("keep"));
    expect(store.values.get("other")).toEqual(content("other"));
  });
});
