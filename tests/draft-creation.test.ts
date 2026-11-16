import { describe, expect, it, vi } from "vitest";
import { beginDraftAttachments, beginDraftCreation, draftCreationGuard, isDraftAttachmentPending, isDraftCreationPending, subscribeDraftCreation } from "../client/chat/composer/draft-creation";
import { mutateDraft, type DraftContent } from "../client/chat/composer/draft-mutations";

describe("draft creation across route mounts", () => {
  it("keeps creation pending across unmount and blocks a second start", () => {
    const store = {};
    const first = vi.fn();
    const unmount = subscribeDraftCreation(store, "draft", first);
    const release = beginDraftCreation(store, "draft");
    expect(first).toHaveBeenCalledOnce();
    unmount();
    const next = vi.fn();
    const unmountNext = subscribeDraftCreation(store, "draft", next);
    expect(isDraftCreationPending(store, "draft")).toBe(true);
    expect(() => beginDraftCreation(store, "draft")).toThrow("still being created");
    release();
    expect(isDraftCreationPending(store, "draft")).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    unmountNext();
  });

  it("isolates installations, bots, and existing chat keys", () => {
    const store = {};
    const otherStore = {};
    const other = vi.fn();
    const remove = subscribeDraftCreation(store, "other", other);
    const release = beginDraftCreation(store, "draft");
    expect(isDraftCreationPending(store, "other")).toBe(false);
    expect(isDraftCreationPending(store, "agent:existing")).toBe(false);
    expect(isDraftCreationPending(otherStore, "draft")).toBe(false);
    const releaseOther = beginDraftCreation(otherStore, "draft");
    release();
    expect(isDraftCreationPending(otherStore, "draft")).toBe(true);
    expect(other).not.toHaveBeenCalled();
    releaseOther();
    remove();
  });

  it("makes release idempotent so an old completion cannot unlock a newer request", () => {
    const store = {};
    const releaseFirst = beginDraftCreation(store, "draft");
    releaseFirst();
    const releaseNext = beginDraftCreation(store, "draft");
    releaseFirst();
    expect(isDraftCreationPending(store, "draft")).toBe(true);
    releaseNext();
    releaseNext();
    expect(isDraftCreationPending(store, "draft")).toBe(false);
  });

  it("allows retry after a failed creation releases in finally", async () => {
    const store = {};
    const start = async () => {
      const release = beginDraftCreation(store, "draft");
      try { await Promise.reject(new Error("offline")); }
      finally { release(); }
    };
    await expect(start()).rejects.toThrow("offline");
    expect(isDraftCreationPending(store, "draft")).toBe(false);
    const release = beginDraftCreation(store, "draft");
    release();
  });

  it("prevents attachment acquisition during creation without changing pending ownership", () => {
    const store = {};
    const release = beginDraftCreation(store, "draft");
    expect(() => beginDraftAttachments(store, "draft")).toThrow("before adding attachments");
    expect(isDraftAttachmentPending(store, "draft")).toBe(false);
    expect(isDraftCreationPending(store, "draft")).toBe(true);
    release();
  });

  it("waits for every accepted attachment batch even after the original composer unmounts", () => {
    const store = {};
    const first = beginDraftAttachments(store, "draft");
    const second = beginDraftAttachments(store, "draft");
    expect(isDraftAttachmentPending(store, "draft")).toBe(true);
    expect(() => beginDraftCreation(store, "draft")).toThrow("attachments to finish");
    first();
    first();
    expect(isDraftAttachmentPending(store, "draft")).toBe(true);
    expect(() => beginDraftCreation(store, "draft")).toThrow("attachments to finish");
    second();
    expect(isDraftAttachmentPending(store, "draft")).toBe(false);
    const release = beginDraftCreation(store, "draft");
    release();
  });

  it("rejects a picker opened before creation even if it resolves after creation finishes", () => {
    const store = {};
    const before = draftCreationGuard(store, "draft");
    expect(before()).toBe(true);
    const release = beginDraftCreation(store, "draft");
    const during = draftCreationGuard(store, "draft");
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    release();
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    expect(draftCreationGuard(store, "draft")()).toBe(true);
  });

  it("does not invalidate a picker for another draft or while its files are being read", () => {
    const store = {};
    const guard = draftCreationGuard(store, "draft");
    const releaseOther = beginDraftCreation(store, "other");
    const releaseFiles = beginDraftAttachments(store, "draft");
    expect(guard()).toBe(true);
    releaseOther();
    releaseFiles();
    expect(guard()).toBe(true);
  });

  it("keeps accepted pre-send attachments and newer typing before allowing creation", async () => {
    let draft: DraftContent = { text: "message", attachments: [] };
    const store = {
      load: async () => {},
      get: () => ({ ...draft, updatedAt: 1 }),
      set: (_key: string, next: DraftContent | null) => { draft = next ?? { text: "", attachments: [] }; },
    };
    const releaseFiles = beginDraftAttachments(store, "draft");
    draft = { ...draft, text: "message plus typing after returning" };
    expect(() => beginDraftCreation(store, "draft")).toThrow("attachments to finish");
    const attachment = { kind: "text" as const, id: "file", name: "note.txt", size: 4, text: "note" };
    await mutateDraft(store, "draft", (current) => ({ ...current, attachments: [...current.attachments, attachment] }));
    releaseFiles();
    expect(draft).toEqual({ text: "message plus typing after returning", attachments: [attachment] });
    const release = beginDraftCreation(store, "draft");
    expect(draft.attachments).toEqual([attachment]);
    release();
  });
});
