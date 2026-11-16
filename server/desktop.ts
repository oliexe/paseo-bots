import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { desktopFrameRpc, desktopInputRpc, DesktopInputSchema, desktopRequestAccessRpc, desktopStartRpc, DesktopStatusSchema, desktopStatusRpc, desktopStopRpc, type DesktopStatus } from "../shared/desktop";
import { pluginDataPath } from "./bot-home";
import { DESKTOP_HELPER_SOURCE } from "./desktop-native";

const SESSION_MS = 15 * 60_000;
const FRAME_LIMIT = 10 * 1024 * 1024;
const Frame = z.object({ image: z.string().startsWith("data:image/jpeg;base64,"), width: z.number().positive(), height: z.number().positive() });
interface Session {
  control: boolean;
  expiresAt: number;
  abort: AbortController;
  expiry: ReturnType<typeof setTimeout>;
  active: Set<Promise<unknown>>;
}

/** Desktop operations stay inside authenticated plugin RPCs; no VNC or HTTP port is opened. */
export class HostDesktop {
  private readonly sessions = new Map<string, Session>();
  private readonly stopping = new Map<string, Promise<{ ok: boolean }>>();
  private readonly children = new Map<ReturnType<typeof spawn>, (error: Error) => void>();
  private compiled: Promise<string> | null = null;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  private command(file: string, args: string[], input = "", timeout = 15_000, limit = FRAME_LIMIT, signal?: AbortSignal): Promise<string> {
    if (this.stopped) return Promise.reject(new Error("Desktop access has stopped."));
    if (signal?.aborted) return Promise.reject(new Error("Desktop session expired. Connect again to continue."));
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      const chunks: Buffer[] = [];
      let size = 0, finished = false;
      let cancellation: Error | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        this.children.delete(child);
        if (error) reject(error);
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const cancel = (error: Error) => {
        if (finished || cancellation) return;
        cancellation = error;
        // The helper handles SIGTERM between input packets and releases any
        // held button/key before exiting. Escalate only if it cannot respond.
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(error); }, 1_000);
        killTimer.unref();
      };
      const onAbort = () => cancel(new Error("Desktop session expired. Connect again to continue."));
      const timer = setTimeout(() => cancel(new Error("The desktop did not respond in time. Check the host and try again.")), timeout);
      this.children.set(child, cancel);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) cancel(new Error("The desktop response was too large. Try a lower image size."));
        else chunks.push(chunk);
      });
      // Compiler diagnostics may contain host paths. Surface an actionable message instead.
      child.stderr.resume();
      child.on("error", () => finish(new Error(file.endsWith("swiftc") ? "Install Apple's Command Line Tools on the host to enable desktop access (xcode-select --install)." : "Could not start the desktop helper on the host.")));
      child.on("close", (code) => {
        if (cancellation) { finish(cancellation); return; }
        const output = Buffer.concat(chunks).toString("utf8");
        if (code !== 0) {
          let message = file.endsWith("swiftc") ? "Could not build the desktop helper. Update Apple's Command Line Tools and try again." : "Desktop access failed. Check Screen Recording and Accessibility for the app macOS identifies (Paseo or Paseo Helper) on the host.";
          try { const parsed = JSON.parse(output) as { error?: unknown }; if (typeof parsed.error === "string") message = parsed.error; } catch { /* no helper response */ }
          finish(new Error(message));
        } else finish();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  private helper(): Promise<string> {
    if (!this.compiled) {
      this.compiled = (async () => {
        const dir = join(pluginDataPath(), "desktop");
        const hash = createHash("sha256").update(DESKTOP_HELPER_SOURCE).digest("hex").slice(0, 16);
        const binary = join(dir, `desktop-${process.arch}-${hash}`);
        try { await access(binary); return binary; } catch { /* compile once */ }
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const source = join(dir, `desktop-${hash}.swift`);
        const output = `${binary}.${process.pid}.building`;
        await writeFile(source, DESKTOP_HELPER_SOURCE, { mode: 0o600 });
        await this.command("/usr/bin/swiftc", ["-parse-as-library", "-O", source, "-o", output], "", 55_000);
        await chmod(output, 0o700);
        await rename(output, binary);
        return binary;
      })().catch((error) => { this.compiled = null; throw error; });
    }
    return this.compiled;
  }

  private async native(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const result = await this.command(await this.helper(), [], JSON.stringify(request), 15_000, FRAME_LIMIT, signal);
    try { return JSON.parse(result); } catch { throw new Error("The desktop helper returned an unreadable response."); }
  }

  async status(): Promise<DesktopStatus> {
    const supported = process.platform === "darwin" && Number(release().split(".")[0]) >= 23;
    const base: DesktopStatus = { supported, platform: process.platform, screenRecording: false, accessibility: false, displays: [], message: null };
    if (!supported) return { ...base, message: "Host desktop access currently requires macOS 14 or later. Bots and chats work on this host." };
    try {
      const result = DesktopStatusSchema.parse({ ...base, ...await this.native({ action: "status" }) as object });
      if (!result.screenRecording) result.message = "Allow Screen Recording for the app macOS identifies (Paseo or Paseo Helper) in the host's System Settings → Privacy & Security. Reopen Paseo if macOS asks.";
      else if (!result.displays.length) result.message = "No active displays. Sign in to the host's desktop and try again.";
      return result;
    } catch (error) { return { ...base, message: error instanceof Error ? error.message : "Could not inspect the host desktop." }; }
  }

  private prune(): void { for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) void this.stopSession(id); }
  private session(id: string, control = false): Session {
    this.prune();
    const session = this.sessions.get(id);
    if (this.stopped || !session) throw new Error("Desktop session expired. Connect again to continue.");
    if (control && !session.control) throw new Error("This is a view-only session. Reconnect with control enabled.");
    return session;
  }

  async start(control: boolean) {
    const status = await this.status();
    if (this.stopped) throw new Error("Desktop access has stopped.");
    if (!status.supported || !status.screenRecording || !status.displays.length) throw new Error(status.message ?? "The host desktop is unavailable.");
    if (control && !status.accessibility) throw new Error("Allow Accessibility for the app macOS identifies (Paseo or Paseo Helper) in the host's System Settings → Privacy & Security to enable control.");
    this.prune();
    if (this.sessions.size >= 8) throw new Error("Too many open desktop sessions. Disconnect an existing viewer and try again.");
    if (control && [...this.sessions.values()].some((session) => session.control)) throw new Error("Another desktop session is controlling this host. Disconnect it first, or connect in view-only mode.");
    const session = randomBytes(24).toString("hex"), expiresAt = Date.now() + SESSION_MS;
    const expiry = setTimeout(() => { void this.stopSession(session); }, SESSION_MS);
    expiry.unref();
    this.sessions.set(session, { control, expiresAt, abort: new AbortController(), expiry, active: new Set() });
    return { session, expiresAt: new Date(expiresAt).toISOString(), control, status };
  }

  async requestAccess(access: "screen" | "control"): Promise<DesktopStatus> {
    const current = await this.status();
    if (!current.supported) throw new Error(current.message ?? "Desktop access is unavailable on this host.");
    await this.native({ action: "requestAccess", access });
    return this.status();
  }

  stopSession(id: string): Promise<{ ok: boolean }> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve({ ok: true });
    const task = (async () => {
      this.sessions.delete(id);
      clearTimeout(session.expiry);
      session.abort.abort();
      // A successful stop means the current helper has finished releasing
      // input, not merely that future requests have lost their lease.
      await Promise.allSettled([...session.active]);
      return { ok: true };
    })();
    this.stopping.set(id, task);
    void task.finally(() => { this.stopping.delete(id); });
    return task;
  }
  private async inSession(session: Session, request: Record<string, unknown>): Promise<unknown> {
    const task = this.native(request, session.abort.signal);
    session.active.add(task);
    try { return await task; } finally { session.active.delete(task); }
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 4) throw new Error("The desktop is busy. Wait for the current action to finish.");
    this.pending++;
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    try { return await next; } finally { this.pending--; }
  }
  async frame(input: { session: string; displayId: number; maxDimension: number }) {
    return this.serial(async () => {
      const session = this.session(input.session);
      const frame = Frame.parse(await this.inSession(session, { action: "capture", displayId: input.displayId, maxDimension: input.maxDimension }));
      this.session(input.session);
      return { ...frame, capturedAt: new Date().toISOString() };
    });
  }
  async input(input: { session: string; displayId: number; input: unknown }) {
    const action = DesktopInputSchema.parse(input.input);
    return this.serial(async () => {
      const session = this.session(input.session, true);
      await this.inSession(session, { action: "input", displayId: input.displayId, input: action });
      this.session(input.session, true);
      return { ok: true };
    });
  }
  dispose(): void {
    this.stopped = true;
    for (const id of this.sessions.keys()) void this.stopSession(id);
    for (const cancel of this.children.values()) cancel(new Error("Desktop access has stopped."));
  }
}

export function registerDesktop(server: PluginServerContext): () => void {
  const desktop = new HostDesktop();
  server.handle(desktopStatusRpc, () => desktop.status());
  server.handle(desktopRequestAccessRpc, ({ access }) => desktop.requestAccess(access));
  server.handle(desktopStartRpc, ({ control }) => desktop.start(control));
  server.handle(desktopStopRpc, ({ session }) => desktop.stopSession(session));
  server.handle(desktopFrameRpc, (input) => desktop.frame(input));
  server.handle(desktopInputRpc, (input) => desktop.input(input));
  return () => desktop.dispose();
}
