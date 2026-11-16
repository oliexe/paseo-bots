import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

function element(overrides: Record<string, unknown> = {}) {
  return { clientWidth: 800, clientHeight: 600, isConnected: true, parentElement: null, getAttribute: (_name: string): string | null => null, style: { display: "flex", visibility: "visible" }, ...overrides };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("retained screen visibility", () => {
  it("hides retained screens when an ancestor is hidden, without relying on viewport position", async () => {
    vi.stubGlobal("window", { getComputedStyle: (node: { style: unknown }) => node.style });
    const { surfaceIsVisible } = await import("../client/web");
    const parent = element();
    const root = element({ parentElement: parent, getBoundingClientRect: () => ({ top: -2000, left: 0 }) });
    expect(surfaceIsVisible(root)).toBe(true);
    parent.style.display = "none";
    expect(surfaceIsVisible(root)).toBe(false);
    parent.style.display = "flex";
    parent.style.visibility = "hidden";
    expect(surfaceIsVisible(root)).toBe(false);
    parent.style.visibility = "visible";
    parent.getAttribute = (name) => name === "aria-hidden" ? "true" : null;
    expect(surfaceIsVisible(root)).toBe(false);
  });

  it("requires a connected root with actual layout dimensions", async () => {
    vi.stubGlobal("window", { getComputedStyle: (node: { style: unknown }) => node.style });
    const { surfaceIsVisible } = await import("../client/web");
    expect(surfaceIsVisible(null)).toBe(false);
    expect(surfaceIsVisible(element({ clientWidth: 0 }))).toBe(false);
    expect(surfaceIsVisible(element({ clientHeight: 0 }))).toBe(false);
    expect(surfaceIsVisible(element({ isConnected: false }))).toBe(false);
    expect(surfaceIsVisible(element())).toBe(true);
  });

  it("observes root resize and ancestor visibility attributes and disposes both subscriptions", async () => {
    const resized: unknown[] = [], mutated: unknown[] = [];
    const disconnectResize = vi.fn(), disconnectMutation = vi.fn();
    let resizeCallback: (() => void) | undefined, mutationCallback: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resizeCallback = callback; } observe(node: unknown) { resized.push(node); } disconnect = disconnectResize; });
    vi.stubGlobal("MutationObserver", class { constructor(callback: () => void) { mutationCallback = callback; } observe(node: unknown, options: unknown) { mutated.push([node, options]); } disconnect = disconnectMutation; });
    const { observeSurfaceVisibility } = await import("../client/web");
    const parent = element(), root = element({ parentElement: parent }), changed = vi.fn();
    const stop = observeSurfaceVisibility(root, changed);
    expect(resized).toEqual([root]);
    expect(mutated).toEqual([root, parent].map((node) => [node, { attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden"] }]));
    resizeCallback?.(); mutationCallback?.();
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    expect(disconnectResize).toHaveBeenCalledOnce();
    expect(disconnectMutation).toHaveBeenCalledOnce();
  });
});
