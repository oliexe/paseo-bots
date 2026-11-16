import { describe, expect, it, vi } from "vitest";
import { stopAgent } from "../client/stop-agent";
import { queueDrainAfterRunning, shouldDrainQueue } from "../client/chat/composer/logic";
import { isQueuePaused, setQueuePaused, subscribeQueuePause } from "../client/chat/composer/queue-pause";

describe("stopping a bot through public Paseo APIs", () => {
  it("keeps Stop's queue pause when the composer unmounts and another surface opens it", () => {
    const changed = vi.fn();
    const unsubscribe = subscribeQueuePause(changed);
    setQueuePaused("agent:host:stopped-chat", true);
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(isQueuePaused("agent:host:stopped-chat")).toBe(true);
    expect(isQueuePaused("agent:other-host:stopped-chat")).toBe(false);
    setQueuePaused("agent:host:stopped-chat", false);
    expect(isQueuePaused("agent:host:stopped-chat")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("keeps queued messages paused throughout a user stop until explicitly resumed", () => {
    let state = queueDrainAfterRunning("stopped", true);
    expect(state).toBe("stopped");
    state = queueDrainAfterRunning(state, false);
    expect(shouldDrainQueue({ running: false, queued: 2, inFlight: state !== "idle", hasAgent: true })).toBe(false);
    expect(queueDrainAfterRunning("awaiting", true)).toBe("idle");
    expect(queueDrainAfterRunning("paused", true)).toBe("idle");
    expect(shouldDrainQueue({ running: false, queued: 2, inFlight: false, hasAgent: true })).toBe(true);
  });
  const setup = (status: string, permissions: { id: string }[] = []) => {
    const handle = { refresh: vi.fn().mockResolvedValue({ agent: { status, pendingPermissions: permissions } }), reload: vi.fn(), respondToPermission: vi.fn() };
    return { handle, api: { agents: { ref: () => handle } } as never };
  };
  it("denies a waiting permission with interruption", async () => {
    const { api, handle } = setup("running", [{ id: "permission" }]);
    await stopAgent(api, "agent");
    expect(handle.respondToPermission).toHaveBeenCalledWith({ requestId: "permission", response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." } });
    expect(handle.reload).not.toHaveBeenCalled();
  });
  it("still interrupts if another client answers the permission before Stop can deny it", async () => {
    const { api, handle } = setup("running", [{ id: "permission" }]);
    handle.refresh.mockResolvedValueOnce({ agent: { status: "running", pendingPermissions: [{ id: "permission" }] } }).mockResolvedValueOnce({ agent: { status: "running", pendingPermissions: [] } });
    handle.respondToPermission.mockRejectedValue(new Error("Permission no longer pending"));
    await stopAgent(api, "agent");
    expect(handle.reload).toHaveBeenCalledTimes(1);
  });
  it("keeps permission failures visible when the same permission is still pending", async () => {
    const { api, handle } = setup("running", [{ id: "permission" }]);
    handle.respondToPermission.mockRejectedValue(new Error("Disconnected"));
    await expect(stopAgent(api, "agent")).rejects.toThrow("Disconnected");
    expect(handle.reload).not.toHaveBeenCalled();
  });
  it("interrupts a running turn by reopening its provider session", async () => {
    const { api, handle } = setup("running");
    await stopAgent(api, "agent");
    expect(handle.reload).toHaveBeenCalledTimes(1);
    expect(handle.respondToPermission).not.toHaveBeenCalled();
  });
  it("does not reload a turn that finished while the stop button was being pressed", async () => {
    const { api, handle } = setup("idle");
    await stopAgent(api, "agent");
    expect(handle.reload).not.toHaveBeenCalled();
  });
  it("reports a missing chat", async () => {
    const { api, handle } = setup("idle");
    handle.refresh.mockResolvedValue(null);
    await expect(stopAgent(api, "missing")).rejects.toThrow("no longer available");
  });
});
