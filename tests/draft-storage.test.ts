import { describe, expect, it } from "vitest";
import { DeviceStore, type DeviceSettingsSnapshot, type DraftStorage } from "../client/device-store";
import { ComposerDraftStore } from "../client/chat/composer/draft-store";
import { parseDrafts, serializeDrafts } from "../client/chat/composer/logic";
import type { DeviceStorageValues } from "../shared/device-storage";
import { mergeBotEdit } from "../shared/bot-edits";
import { makeBot, NOW } from "./helpers";

const item = (value: string, updatedAt = 1) => ({ value, updatedAt });

function device(initial: DeviceStorageValues = { items: {} }) {
  const store = new DeviceStore();
  let revision = 1;
  let saved = initial;
  let fail = false;
  let writes = 0;
  const update = () => store.update(snapshot());
  const snapshot = (): DeviceSettingsSnapshot => ({
    status: "ready", revision: String(revision), values: saved,
    save: async (values, expected) => {
      writes++;
      if (fail || expected !== String(revision)) return false;
      saved = values; revision++;
      update();
      return true;
    },
    reload: async () => { update(); },
  });
  update();
  return { store, saved: () => saved, fail: (value: boolean) => { fail = value; }, writes: () => writes, external: (values: DeviceStorageValues) => { saved = values; revision++; update(); } };
}

describe("public device draft storage", () => {
  it("serializes concurrent card and composer writes without dropping either", async () => {
    const { store, saved } = device({ items: { existing: item("keep") } });
    await Promise.all([store.writeItem("draft", "new draft"), store.writeItem("card", "answer"), store.writeItem("draft", "newest draft")]);
    expect(saved().items).toMatchObject({ existing: { value: "keep" }, draft: { value: "newest draft" }, card: { value: "answer" } });
  });

  it("preserves edits across a failed save and exposes the failure instead of acknowledging it", async () => {
    const state = device();
    state.fail(true);
    await expect(state.store.writeItem("draft", "keep me")).rejects.toThrow("Couldn't save drafts");
    expect(state.store.readItemSync("draft")).toBe("keep me");
    expect(state.store.takeError()).toContain("Couldn't save drafts");
    expect(state.store.takeError()).toBeNull();
    state.fail(false);
    await state.store.writeItem("draft", "keep me too");
    expect(state.saved().items.draft.value).toBe("keep me too");
  });

  it("retains dirty values over a newer remote revision", async () => {
    const state = device();
    state.fail(true);
    await state.store.writeItem("draft", "local").catch(() => {});
    state.fail(false);
    state.external({ items: { remote: item("other surface") } });
    await state.store.flush();
    expect(state.saved().items).toMatchObject({ draft: { value: "local" }, remote: { value: "other surface" } });
  });

  it("evicts settled old entries before current changes and refuses too-large values", async () => {
    const state = device({ items: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`old-${index}`, item("old", index)])) });
    await state.store.writeItem("active", "new");
    expect(Object.keys(state.saved().items)).toHaveLength(100);
    expect(state.saved().items.active.value).toBe("new");
    await expect(state.store.writeItem("huge", "x".repeat(2_100_001))).rejects.toThrow("too large");
    expect(state.saved().items.huge).toBeUndefined();
  });

  it("preserves a deletion and new typing that happened before hydration", async () => {
    let finish!: (text: string) => void;
    let saved = "";
    const storage: DraftStorage = {
      readItemSync: () => null,
      readItem: () => new Promise((resolve) => { finish = resolve; }),
      writeItem: async (_key, value) => { saved = value; },
      subscribe: () => () => {},
    };
    const drafts = new ComposerDraftStore(storage);
    const load = drafts.load();
    drafts.set("deleted", null);
    drafts.set("typed", { text: "new typing", attachments: [] });
    finish(serializeDrafts({ deleted: { text: "must not return", attachments: [], updatedAt: 1 }, typed: { text: "old", attachments: [], updatedAt: 1 }, other: { text: "keep", attachments: [], updatedAt: 1 } }));
    await load;
    await drafts.flush();
    expect(parseDrafts(saved)).toMatchObject({ typed: { text: "new typing" }, other: { text: "keep" } });
    expect(parseDrafts(saved).deleted).toBeUndefined();
  });

  it("never acknowledges dirty records excluded by the storage budget", async () => {
    const state = device();
    const value = "x".repeat(2_000_000);
    const results = await Promise.allSettled([state.store.writeItem("one", value), state.store.writeItem("two", value)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(state.store.readItemSync("one")).toBe(value);
    expect(state.store.readItemSync("two")).toBe(value);
    expect(state.saved().items).toEqual({});
    await state.store.writeItem("one", "shortened");
    expect(state.saved().items.two.value).toBe(value);
  });

  it("never exceeds the UTF-8 budget even with huge text attachments and Unicode", () => {
    const json = serializeDrafts({ latest: { text: "😀中文".repeat(5000), attachments: [{ kind: "text", id: "file", name: "big.txt", size: 50_000, text: "x".repeat(50_000) }], updatedAt: 2 }, old: { text: "old".repeat(1000), attachments: [], updatedAt: 1 } }, { maxBytes: 2000 });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(2000);
    expect(parseDrafts(json).latest.text).toContain("😀中文");
  });
});

describe("bot autosave merges", () => {
  it("keeps a newer pin and model when autosaving only a name", () => {
    const base = makeBot();
    const current = { ...base, pinned: true, model: "new-model" };
    expect(mergeBotEdit(current, { base, patch: { name: "Renamed" } })).toMatchObject({ name: "Renamed", pinned: true, model: "new-model" });
  });

  it("merges independent edits and additions within routine arrays", () => {
    const routine = { id: "r", name: "Routine", prompt: "old", enabled: true, schedule: { kind: "interval" as const, minutes: 30 }, resultsChatId: null, createdAt: NOW };
    const base = makeBot({ routines: [routine] });
    const added = { ...routine, id: "other" };
    const current = { ...base, routines: [{ ...routine, enabled: false }, added] };
    expect(mergeBotEdit(current, { base, patch: { routines: [{ ...routine, prompt: "new instructions" }] } }).routines).toEqual([{ ...routine, enabled: false, prompt: "new instructions" }, added]);
  });

  it("does not resurrect concurrently deleted routines or drop newly granted skills", () => {
    const routine = { id: "r", name: "Routine", prompt: "old", enabled: true, schedule: { kind: "interval" as const, minutes: 30 }, resultsChatId: null, createdAt: NOW };
    const base = makeBot({ routines: [routine], skillIds: ["old"] });
    const current = { ...base, routines: [], skillIds: ["old", "remote"] };
    const next = mergeBotEdit(current, { base, patch: { routines: [{ ...routine, prompt: "changed" }], skillIds: ["local"] } });
    expect(next.routines).toEqual([]);
    expect(next.skillIds).toEqual(["remote", "local"]);
  });
});
