import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
const callbacks: (() => void)[] = [];
beforeEach(() => {
  callbacks.length = 0;
  vi.stubGlobal("window", { getComputedStyle: (node: { style: unknown }) => node.style });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function list() {
  const positions = new Map([["bot-chat-a", 380], ["bot-chat-b", 430], ["bot-chat-c", 480]]);
  const listeners = new Map<string, () => void>();
  const node = {
    clientWidth: 320, clientHeight: 200, scrollTop: 0, scrollHeight: 1000,
    isConnected: true, parentElement: null, firstElementChild: {}, loading: false,
    style: { display: "flex", visibility: "visible" },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelector: () => node.loading ? {} : null,
    querySelectorAll: () => Array.from(positions, ([key, top]) => ({
      getAttribute: () => key,
      getBoundingClientRect: () => ({ top: top - node.scrollTop, bottom: top - node.scrollTop + 40 }),
    })),
    scroll: vi.fn(({ top }: { top: number }) => { node.scrollTop = top; }),
    addEventListener: (type: string, callback: () => void) => { listeners.set(type, callback); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  return { node, positions, listeners, getScrollableNode: () => node };
}

describe("sidebar route scroll anchors", () => {
  it("recovers a scoped anchor when the host reinstalls client modules on Forward", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const first = await import("../client/web");
    const a = list(), tracking = first.trackSidebarPosition(a, "host/team/context"); a.node.scrollTop = 400; tracking.capture(); tracking.dispose();
    vi.resetModules();
    const next = await import("../client/web"), b = list(); next.trackSidebarPosition(b, "host/team/context").dispose();
    expect(b.node.scrollTop).toBe(400);
    const other = list(); next.trackSidebarPosition(other, "another-host/team/context").dispose(); expect(other.node.scrollTop).toBe(0);
  });
  it("does not save transient clamping while other Bot queries still show skeletons", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "scope"); a.node.scrollTop = 400; tracking.capture();
    const b = list(); b.node.loading = true; trackSidebarPosition(b, "scope");
    b.node.scrollTop = 292; b.listeners.get("scroll")?.(); callbacks.forEach(callback => callback());
    expect(b.node.scroll).not.toHaveBeenCalled();
    b.node.loading = false; callbacks.forEach(callback => callback());
    expect(b.node.scrollTop).toBe(400);
  });
  it("restores the same row and inset in a fresh route, even after rows were inserted above it", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "host-a/team-a/full-list");
    a.node.scrollTop = 400; tracking.capture();
    const b = list(); for (const [key, y] of b.positions) b.positions.set(key, y + 75);
    const next = trackSidebarPosition(b, "host-a/team-a/full-list");
    expect(b.node.scrollTop).toBe(475); // same row a, 20px above viewport, not blindly 400
    tracking.dispose(); next.dispose(); expect(b.listeners.size).toBe(0);
  });

  it("isolates host, team and filter contexts and ignores scrolls from hidden retained screens", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "host-a/team-a/empty-query");
    a.node.scrollTop = 400; tracking.capture(); a.node.style.display = "none";
    a.node.scrollTop = 0; tracking.capture(); tracking.dispose();
    for (const scope of ["host-b/team-a/empty-query", "host-a/team-b/empty-query", "host-a/team-a/search"])
      expect((() => { const b = list(); trackSidebarPosition(b, scope).dispose(); return b.node.scrollTop; })()).toBe(0);
    const restored = list(); trackSidebarPosition(restored, "host-a/team-a/empty-query").dispose();
    expect(restored.node.scrollTop).toBe(400);
  });

  it("waits for the recorded row through content notifications rather than a fixed delay", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "scope"); a.node.scrollTop = 400; tracking.capture();
    const b = list(); b.positions.clear(); b.node.loading = true; trackSidebarPosition(b, "scope");
    expect(b.node.scroll).not.toHaveBeenCalled();
    b.positions.set("bot-chat-a", 380); b.node.loading = false;
    callbacks.forEach(callback => callback());
    expect(b.node.scrollTop).toBe(400);
  });

  it("preserves a visible anchor through background title/message reordering", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "scope"); a.node.scrollTop = 400; tracking.capture();
    a.positions.set("bot-chat-a", 480); callbacks.forEach(callback => callback());
    expect(a.node.scrollTop).toBe(500);
  });

  it("lets explicit user scrolling supersede a pending restoration", async () => {
    const { trackSidebarPosition } = await import("../client/web");
    const a = list(), tracking = trackSidebarPosition(a, "scope"); a.node.scrollTop = 400; tracking.capture(); a.node.style.display = "none";
    const b = list(); b.node.loading = true; trackSidebarPosition(b, "scope");
    b.node.scrollTop = 200; b.listeners.get("wheel")?.(); b.node.loading = false;
    callbacks.forEach(callback => callback()); expect(b.node.scrollTop).toBe(200);
  });

  it("does not access DOM or storage on React Native platforms", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    try {
      const { trackSidebarPosition } = await import("../client/web");
      const getScrollableNode = vi.fn(() => { throw new Error("DOM must not be accessed"); });
      const tracking = trackSidebarPosition({ getScrollableNode }, "host/team/context");
      tracking.capture(); tracking.dispose(); expect(getScrollableNode).not.toHaveBeenCalled();
    } finally { vi.doMock("react-native", () => ({ Platform: { OS: "web" } })); }
  });
});
