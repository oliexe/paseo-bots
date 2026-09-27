import { spawn } from "node:child_process";
import type { McpServerConfig, McpTool } from "../shared/bot";
import { PLUGIN_VERSION } from "../shared/version";

// Connects to an MCP server the way an agent would, lists its tools and
// disconnects. Nothing is kept running; the result only tells the user whether
// the server starts and what it offers.

const TIMEOUT_MS = 30_000;
const MAX_TOOLS = 200;
const MAX_PAGES = 5;
const PROTOCOL_VERSION = "2025-06-18";

export type ProbeResult = { ok: true; tools: McpTool[] } | { ok: false; error: string };

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string };
}

/** Sends one JSON-RPC request and resolves with its result. */
type Request = (method: string, params?: unknown) => Promise<unknown>;
type Notify = (method: string) => Promise<void>;

const initializeParams = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "paseo-bot", version: PLUGIN_VERSION } };

async function listTools(request: Request, notify: Notify): Promise<McpTool[]> {
  await request("initialize", initializeParams);
  await notify("notifications/initialized");
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
    const result = (await request("tools/list", cursor ? { cursor } : {})) as { tools?: { name?: unknown; description?: unknown }[]; nextCursor?: string };
    for (const tool of result.tools ?? []) {
      if (typeof tool.name === "string") tools.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description.split("\n")[0]!.slice(0, 300) : "" });
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools.slice(0, MAX_TOOLS);
}

function rpcError(response: JsonRpcResponse): Error {
  return new Error(response.error?.message || "The server returned an error.");
}

// ---------------------------------------------------------------- stdio

function probeStdio(config: Extract<McpServerConfig, { type: "stdio" }>, signal: AbortSignal): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      // npx, uvx and friends are .cmd shims on Windows.
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let nextId = 1;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error: Error | null, tools?: McpTool[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    const onAbort = () => finish(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds.${lastLine(stderr)}`));
    signal.addEventListener("abort", onAbort);

    child.on("error", (error) => finish(new Error(`Couldn't start "${config.command}": ${error.message}`)));
    child.on("exit", (code) => finish(new Error(`The server exited${code === null ? "" : ` with code ${code}`} before answering.${lastLine(stderr)}`)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let index: number;
      while ((index = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id as number);
        if (message.error) waiter.reject(rpcError(message));
        else waiter.resolve(message.result);
      }
    });

    const write = (payload: object) => child.stdin.write(JSON.stringify(payload) + "\n");
    const request: Request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    const notify: Notify = async (method) => {
      write({ jsonrpc: "2.0", method });
    };
    listTools(request, notify).then(
      (tools) => finish(null, tools),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function lastLine(stderr: string): string {
  const line = stderr.trim().split("\n").pop()?.trim();
  return line ? ` ${line.slice(0, 300)}` : "";
}

// ---------------------------------------------------------------- HTTP

/** Yields `{event, data}` pairs from a text/event-stream body. */
async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function httpFailure(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => "")).trim().slice(0, 200);
  const hint = response.status === 401 || response.status === 403 ? " Check the server's headers (for example an Authorization token)." : "";
  return new Error(`The server answered ${response.status}${text ? `: ${text}` : "."}${hint}`);
}

/** Streamable HTTP: every message is a POST; answers come back as JSON or as a short event stream. */
async function probeHttp(config: Extract<McpServerConfig, { type: "http" }>, signal: AbortSignal): Promise<McpTool[]> {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = (payload: object) =>
    fetch(config.url, {
      method: "POST",
      signal,
      headers: {
        ...config.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
  const request: Request = async (method, params) => {
    const id = nextId++;
    const response = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    if (!response.ok) throw await httpFailure(response);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    let message: JsonRpcResponse | undefined;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
      for await (const { data } of serverEvents(response.body)) {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === id) {
          message = parsed;
          break;
        }
      }
    } else {
      message = (await response.json()) as JsonRpcResponse;
    }
    if (!message) throw new Error("The server closed the connection without answering.");
    if (message.error) throw rpcError(message);
    return message.result;
  };
  const notify: Notify = async (method) => {
    const response = await post({ jsonrpc: "2.0", method });
    await response.body?.cancel().catch(() => {});
  };
  try {
    return await listTools(request, notify);
  } finally {
    if (sessionId) {
      void fetch(config.url, { method: "DELETE", headers: { ...config.headers, "Mcp-Session-Id": sessionId } }).catch(() => {});
    }
  }
}

/** The older HTTP+SSE transport: an event stream names a URL to POST to, and answers arrive on the stream. */
async function probeSse(config: Extract<McpServerConfig, { type: "sse" }>, signal: AbortSignal): Promise<McpTool[]> {
  const stream = await fetch(config.url, { signal, headers: { ...config.headers, Accept: "text/event-stream" } });
  if (!stream.ok || !stream.body) throw await httpFailure(stream);
  const events = serverEvents(stream.body);
  try {
    let endpoint: string | null = null;
    for await (const { event, data } of events) {
      if (event === "endpoint") {
        endpoint = new URL(data, config.url).toString();
        break;
      }
    }
    if (!endpoint) throw new Error("The server's event stream didn't say where to send messages.");
    const target = endpoint;
    let nextId = 1;
    const send = async (payload: object) => {
      const response = await fetch(target, { method: "POST", signal, headers: { ...config.headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw await httpFailure(response);
      await response.body?.cancel().catch(() => {});
    };
    const request: Request = async (method, params) => {
      const id = nextId++;
      await send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      for await (const { event, data } of events) {
        if (event !== "message") continue;
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id !== id) continue;
        if (parsed.error) throw rpcError(parsed);
        return parsed.result;
      }
      throw new Error("The server closed the connection without answering.");
    };
    return await listTools(request, (method) => send({ jsonrpc: "2.0", method }));
  } finally {
    await events.return(undefined);
  }
}

// ---------------------------------------------------------------- entry

/** Hides env and header values (usually keys) from anything shown to the user. */
function redact(text: string, config: McpServerConfig): string {
  const secrets = Object.values(config.type === "stdio" ? config.env : config.headers).filter((value) => value.length >= 4);
  return secrets.reduce((out, secret) => out.split(secret).join("•••"), text);
}

export async function probeMcpServer({ config }: { config: McpServerConfig }): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const tools =
      config.type === "stdio" ? await probeStdio(config, controller.signal) : config.type === "http" ? await probeHttp(config, controller.signal) : await probeSse(config, controller.signal);
    return { ok: true, tools };
  } catch (error) {
    const message = controller.signal.aborted && !(error instanceof Error && error.message.startsWith("No answer")) ? `No answer within ${TIMEOUT_MS / 1000} seconds.` : error instanceof Error ? error.message : String(error);
    return { ok: false, error: redact(message, config) };
  } finally {
    clearTimeout(timer);
  }
}
