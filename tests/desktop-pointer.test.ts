import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPoint } from "../shared/desktop";

const platform = vi.hoisted(() => ({ OS: "web" }));
vi.mock("react-native", () => ({ Platform: platform }));
afterEach(() => { platform.OS = "web"; vi.resetModules(); });

describe("desktop press coordinates", () => {
  it("uses the canvas bounds instead of page coordinates or a child target", async () => {
    const { pressCoordinates } = await import("../client/web");
    const event = {
      nativeEvent: { clientX: 640, clientY: 436, locationX: 640, locationY: 436, detail: 1 },
      currentTarget: { getBoundingClientRect: () => ({ left: 320, top: 72, width: 640, height: 728 }) },
      target: { getBoundingClientRect: () => ({ left: 600, top: 400, width: 20, height: 20 }) },
    };
    const point = pressCoordinates(event)!;
    expect(point).toEqual({ x: 320, y: 364, box: { width: 640, height: 728 } });
    expect(desktopPoint(point.x, point.y, point.box!, { width: 1600, height: 900 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("reads resized bounds at press time and maps the same host point with either sidebar state", async () => {
    const { pressCoordinates } = await import("../client/web");
    const image = { width: 1600, height: 900 }, hostPoint = { x: 750 / 1919, y: 700 / 1079 };
    let rect = { left: 320, top: 72, width: 960, height: 728 };
    const currentTarget = { getBoundingClientRect: () => rect };
    for (const width of [960, 640, 390]) {
      rect = { ...rect, width };
      const scale = Math.min(rect.width / image.width, rect.height / image.height);
      const nativeEvent = { detail: 1, clientX: rect.left + (rect.width - image.width * scale) / 2 + hostPoint.x * image.width * scale, clientY: rect.top + (rect.height - image.height * scale) / 2 + hostPoint.y * image.height * scale };
      const point = pressCoordinates({ nativeEvent, currentTarget })!;
      expect(point.box!.width).toBe(width);
      const mapped = desktopPoint(point.x, point.y, point.box!, image)!;
      expect(mapped.x).toBeCloseTo(hostPoint.x, 12);
      expect(mapped.y).toBeCloseTo(hostPoint.y, 12);
    }
  });

  it("keeps letterbox clicks outside the host image", async () => {
    const { pressCoordinates } = await import("../client/web");
    const currentTarget = { getBoundingClientRect: () => ({ left: 320, top: 72, width: 640, height: 728 }) };
    const point = pressCoordinates({ nativeEvent: { detail: 1, clientX: 640, clientY: 100 }, currentTarget })!;
    expect(desktopPoint(point.x, point.y, point.box!, { width: 1600, height: 900 })).toBeNull();
  });

  it("ignores keyboard activation and invalid or missing web coordinates", async () => {
    const { pressCoordinates } = await import("../client/web");
    const currentTarget = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };
    expect(pressCoordinates({ nativeEvent: { detail: 0, clientX: 0, clientY: 0 }, currentTarget })).toBeNull();
    expect(pressCoordinates({ nativeEvent: { locationX: 10, locationY: 20 }, currentTarget })).toBeNull();
    expect(pressCoordinates({ nativeEvent: { detail: 1, clientX: NaN, clientY: 20 }, currentTarget })).toBeNull();
    expect(pressCoordinates({ nativeEvent: { detail: 1, clientX: 10, clientY: 20 } })).toBeNull();
  });

  it("retains native touch coordinates on phones", async () => {
    platform.OS = "ios";
    const { pressCoordinates } = await import("../client/web");
    expect(pressCoordinates({ nativeEvent: { locationX: 30, locationY: 40 } })).toEqual({ x: 30, y: 40 });
    expect(pressCoordinates({ nativeEvent: { locationX: NaN, locationY: 40 } })).toBeNull();
  });
});
