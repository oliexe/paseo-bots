import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import type { BotsHost } from "./host";

const execute = promisify(execFile);

/** The public SDK has no plugin startup context. Borrow one when a hook/RPC
 * arrives; until then a server-owned local SDK connection keeps schedules alive
 * without an app. The CLI resolves the selected home and endpoint (including
 * sockets); no plugin IPC or credentials are read from private runtime files. */
export function connectSchedulerHost(host: BotsHost): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let close: (() => Promise<void>) | null = null;
  let connecting: Promise<void> | null = null;
  const release = async () => {
    const current = close;
    close = null;
    await current?.();
  };
  const detach = host.onAttach(() => {
    // A hook can arrive in the middle of create(). Keep the fallback connection
    // alive until teardown so its already-running request can finish safely.
    if (host.hasPluginApi && timer) clearTimeout(timer);
  });
  const connect = async () => {
    if (stopped || host.hasPluginApi) return;
    try {
      const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
      const { stdout } = await execute("paseo", ["daemon", "status", "--json", "--home", home], { timeout: 15_000, maxBuffer: 256 * 1024 });
      if (stopped || host.hasPluginApi) return;
      const status = JSON.parse(stdout) as { listen?: string; connectedDaemon?: string };
      if (!status.listen || status.connectedDaemon !== "reachable") throw new Error("The local Paseo daemon is not reachable.");
      const client = createHostClient(status.listen, { clientId: "paseo-bots-scheduler", connectTimeoutMs: 10_000, reconnect: { enabled: true } });
      const api = createPaseoApi(client);
      close = async () => { await api.dispose(); await client.close(); };
      await client.connect();
      if (stopped || host.hasPluginApi) { await release(); return; }
      host.attach(api, true);
    } catch (error) {
      await release().catch(() => {});
      if (stopped || host.hasPluginApi) return;
      host.bootstrapError = `Unattended scheduler connection failed: ${error instanceof Error ? error.message : String(error)}`;
      timer = setTimeout(start, 30_000);
      timer.unref?.();
    }
  };
  const start = () => { connecting = connect(); };
  timer = setTimeout(start, 1_000);
  timer.unref?.();
  return async () => {
    stopped = true;
    detach();
    if (timer) clearTimeout(timer);
    await release().catch(() => {});
    await connecting;
  };
}
