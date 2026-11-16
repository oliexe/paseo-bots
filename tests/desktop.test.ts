import { afterEach, describe, expect, it, vi } from "vitest";
import { HostDesktop } from "../server/desktop";
import { desktopPoint, DesktopInputSchema, type DesktopStatus } from "../shared/desktop";

const ready: DesktopStatus = { supported: true, platform: "darwin", screenRecording: true, accessibility: true, displays: [{ id: 1, name: "Main", width: 1920, height: 1080 }], message: null };
const frame = { image: "data:image/jpeg;base64,/9j/", width: 1920, height: 1080 };
const click = { kind: "click" as const, x: 0.5, y: 0.5, count: 1 as const, button: "left" as const };
function desktop() {
  const host = new HostDesktop();
  vi.spyOn(host, "status").mockResolvedValue(ready);
  const native = vi.spyOn(host as unknown as { native(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }, "native").mockResolvedValue(frame);
  return { host, native };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("host desktop sessions", () => {
  it("requires OS permissions before a session can view or control the screen", async () => {
    const { host } = desktop();
    vi.mocked(host.status).mockResolvedValue({ ...ready, screenRecording: false, message: "Allow Screen Recording." });
    await expect(host.start(false)).rejects.toThrow("Allow Screen Recording");
    vi.mocked(host.status).mockResolvedValue({ ...ready, accessibility: false });
    await expect(host.start(true)).rejects.toThrow("Allow Accessibility");
    await expect(host.start(false)).resolves.toMatchObject({ control: false });
    host.dispose();
  });

  it("enforces view-only sessions and allows only one controller", async () => {
    const { host, native } = desktop();
    const view = await host.start(false);
    await expect(host.input({ session: view.session, displayId: 1, input: click })).rejects.toThrow("view-only");
    expect(native).not.toHaveBeenCalled();
    await expect(host.frame({ session: view.session, displayId: 1, maxDimension: 1600 })).resolves.toMatchObject(frame);
    const control = await host.start(true);
    await expect(host.start(true)).rejects.toThrow("Another desktop session");
    await expect(host.start(false)).resolves.toMatchObject({ control: false });
    host.stopSession(control.session);
    await expect(host.start(true)).resolves.toMatchObject({ control: true });
    host.dispose();
  });

  it("does not execute queued input or release a captured frame after disconnect", async () => {
    const { host, native } = desktop();
    const connection = await host.start(true);
    let finish!: (result: unknown) => void;
    native.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const capture = host.frame({ session: connection.session, displayId: 1, maxDimension: 1600 });
    const captureResult = expect(capture).rejects.toThrow("expired");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const input = host.input({ session: connection.session, displayId: 1, input: click });
    const inputResult = expect(input).rejects.toThrow("expired");
    host.stopSession(connection.session);
    finish(frame);
    await Promise.all([captureResult, inputResult]);
    expect(native).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("expires a session and rejects all access after disposal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { host, native } = desktop();
    const connection = await host.start(true);
    vi.setSystemTime(new Date(connection.expiresAt));
    await expect(host.input({ session: connection.session, displayId: 1, input: click })).rejects.toThrow("expired");
    expect(native).not.toHaveBeenCalled();
    const renewed = await host.start(false);
    host.dispose();
    await expect(host.frame({ session: renewed.session, displayId: 1, maxDimension: 1600 })).rejects.toThrow("expired");
    await expect(host.start(false)).rejects.toThrow("stopped");
  });

  it("aborts active input and waits for its release before acknowledging any repeated stop", async () => {
    const { host, native } = desktop();
    const connection = await host.start(true);
    let signal: AbortSignal | undefined;
    let release!: () => void;
    native.mockImplementation((_request, inputSignal) => {
      signal = inputSignal;
      return new Promise((resolve) => { release = () => resolve({ ok: true }); });
    });
    const input = host.input({ session: connection.session, displayId: 1, input: { kind: "text", text: "Long input" } });
    const result = expect(input).rejects.toThrow("expired");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = host.stopSession(connection.session);
    expect(signal?.aborted).toBe(true);
    expect(host.stopSession(connection.session)).toBe(stopping);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([result, stopping]);
    expect(stopped).toBe(true);
    host.dispose();
  });

  it("expires active input on its timer without needing another RPC", async () => {
    vi.useFakeTimers();
    const { host, native } = desktop();
    const connection = await host.start(true);
    let signal: AbortSignal | undefined;
    native.mockImplementation((_request, inputSignal) => {
      signal = inputSignal;
      return new Promise((_resolve, reject) => inputSignal?.addEventListener("abort", () => reject(new Error("Desktop session expired.")), { once: true }));
    });
    const input = host.input({ session: connection.session, displayId: 1, input: click });
    const result = expect(input).rejects.toThrow("expired");
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(new Date(connection.expiresAt).getTime() - Date.now());
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    host.dispose();
  });

  it("disposes active input through its cancellation signal and clears session timers", async () => {
    vi.useFakeTimers();
    const { host, native } = desktop();
    const connection = await host.start(true);
    let signal: AbortSignal | undefined;
    native.mockImplementation((_request, inputSignal) => {
      signal = inputSignal;
      return new Promise((_resolve, reject) => inputSignal?.addEventListener("abort", () => reject(new Error("Desktop session expired.")), { once: true }));
    });
    const input = host.input({ session: connection.session, displayId: 1, input: click });
    const result = expect(input).rejects.toThrow("expired");
    await Promise.resolve();
    host.dispose();
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a session if teardown happens during its permission check", async () => {
    const { host } = desktop();
    let finish!: (result: DesktopStatus) => void;
    vi.mocked(host.status).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const starting = host.start(false);
    host.dispose();
    finish(ready);
    await expect(starting).rejects.toThrow("stopped");
  });

  it("requests permissions only through an explicit action, on supported hosts", async () => {
    const { host, native } = desktop();
    await host.requestAccess("screen");
    expect(native).toHaveBeenCalledWith({ action: "requestAccess", access: "screen" });
    native.mockClear();
    vi.mocked(host.status).mockResolvedValue({ ...ready, supported: false, message: "Requires macOS." });
    await expect(host.requestAccess("control")).rejects.toThrow("Requires macOS");
    expect(native).not.toHaveBeenCalled();
    host.dispose();
  });
});

describe("desktop input", () => {
  it("maps image coordinates and ignores horizontal and vertical letterboxing", () => {
    expect(desktopPoint(100, 100, { width: 200, height: 200 }, { width: 200, height: 100 })).toEqual({ x: 0.5, y: 0.5 });
    expect(desktopPoint(100, 20, { width: 200, height: 200 }, { width: 200, height: 100 })).toBeNull();
    expect(desktopPoint(20, 100, { width: 200, height: 200 }, { width: 100, height: 200 })).toBeNull();
    expect(desktopPoint(100, 100, { width: 200, height: 200 }, { width: 100, height: 200 })).toEqual({ x: 0.5, y: 0.5 });
    expect(desktopPoint(NaN, 100, { width: 200, height: 200 }, { width: 100, height: 200 })).toBeNull();
    expect(desktopPoint(0, 0, { width: 0, height: 200 }, { width: 100, height: 200 })).toBeNull();
  });

  it("rejects out-of-range input and keeps Unicode text intact", () => {
    expect(DesktopInputSchema.safeParse({ ...click, x: -0.1 }).success).toBe(false);
    expect(DesktopInputSchema.safeParse({ kind: "scroll", x: 0.5, y: 0.5, delta: 200 }).success).toBe(false);
    expect(DesktopInputSchema.safeParse({ kind: "key", key: "unknown" }).success).toBe(false);
    expect(DesktopInputSchema.parse({ kind: "text", text: "Příliš žluťoučký 🤖" })).toEqual({ kind: "text", text: "Příliš žluťoučký 🤖" });
  });
});
