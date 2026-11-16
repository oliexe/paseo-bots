import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "web" }));
vi.mock("react-native", () => ({ Platform: platform }));
afterEach(() => { platform.OS = "web"; vi.unstubAllGlobals(); vi.resetModules(); });

describe("web chat list measurements", () => {
  it("uses the browser's measured end instead of React Native Web's scrollTo replacement", async () => {
    const { scrollWebListToEnd } = await import("../client/web");
    const node = { scrollHeight: 950, firstElementChild: {}, scroll: vi.fn(), scrollTo: vi.fn() };
    const list = { getScrollableNode: () => node };
    scrollWebListToEnd(list);
    node.scrollHeight = 1800;
    scrollWebListToEnd(list, true);
    expect(node.scroll.mock.calls).toEqual([[{ top: 950, behavior: "instant" }], [{ top: 1800, behavior: "smooth" }]]);
    expect(node.scrollTo).not.toHaveBeenCalled();
    expect(() => scrollWebListToEnd(null)).not.toThrow();
    expect(() => scrollWebListToEnd({ getScrollableNode: () => null })).not.toThrow();
  });

  it("observes both the viewport and content so late footer layout can reach the bottom", async () => {
    const observed: unknown[] = [];
    const disconnect = vi.fn();
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe(node: unknown) { observed.push(node); } disconnect = disconnect; });
    const { watchWebListSize } = await import("../client/web");
    const content = {}, node = { firstElementChild: content };
    const changed = vi.fn();
    const stop = watchWebListSize({ getScrollableNode: () => node }, changed);
    expect(observed).toEqual([node, content]);
    expect(changed).toHaveBeenCalledOnce();
    resize();
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    resize();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("still aligns once when ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { watchWebListSize } = await import("../client/web");
    const changed = vi.fn();
    const stop = watchWebListSize({ getScrollableNode: () => ({}) }, changed);
    expect(changed).toHaveBeenCalledOnce();
    expect(stop).not.toThrow();
  });

  it("does not inspect a list or install observers on native platforms", async () => {
    platform.OS = "ios";
    const observer = vi.fn();
    vi.stubGlobal("ResizeObserver", observer);
    const { scrollWebListToEnd, watchWebListSize } = await import("../client/web");
    const list = { getScrollableNode: vi.fn(() => { throw new Error("native ref has no DOM node"); }) };
    const changed = vi.fn();
    scrollWebListToEnd(list);
    watchWebListSize(list, changed)();
    expect(list.getScrollableNode).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
