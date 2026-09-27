import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appCallRefusal } from "../shared/apps";
import type { McpServerConfig } from "../shared/bot";
import { connectedSlugs, deadline, readState, session, writeState } from "./composio";

// Bots reach connected apps through this loopback relay, the way Paseo gives
// agents its own tools: an http MCP server on 127.0.0.1 with a bearer token.
// Each bot's token is signed with a secret only this process knows, the
// Composio key never leaves this process, and every tool call is checked
// against the bot's allowed apps before it is forwarded.

const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const BOT_ID = /^[a-z0-9-]+$/;

/** The apps a bot may use, or null when it may not use connected apps at all. */
export type AllowedApps = (botId: string) => Promise<string[] | null>;

export function botToken(secret: string, botId: string): string {
  return createHmac("sha256", secret).update(botId).digest("hex");
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export class AppsRelay {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;

  constructor(private readonly allowedApps: AllowedApps) {}

  /** Starts listening, on the previous port when it's free so running chats keep their URL. */
  start(): Promise<number> {
    this.listening ??= (async () => {
      const state = await readState();
      const server = createServer((request, response) => void this.handle(request, response));
      const listen = (port: number) =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve((server.address() as { port: number }).port);
          });
        });
      let port: number;
      try {
        port = await listen(state.port ?? 0);
      } catch {
        port = await listen(0);
      }
      this.server = server;
      if (port !== state.port) await writeState({ port });
      return port;
    })();
    return this.listening;
  }

  stop() {
    this.server?.close();
    this.server = null;
    this.listening = null;
  }

  /** The MCP server entry for a bot's chats, or null when connected apps aren't set up. */
  async mount(botId: string): Promise<McpServerConfig | null> {
    const state = await readState();
    if (!state.apiKey) return null;
    const port = await this.start();
    return { type: "http", url: `http://127.0.0.1:${port}/mcp/${botId}`, headers: { Authorization: `Bearer ${botToken(state.secret, botId)}` } };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const botId = /^\/mcp\/([^/?]+)/.exec(request.url ?? "")?.[1];
      const state = await readState();
      if (!botId || !BOT_ID.test(botId) || !tokenMatches(botToken(state.secret, botId), request.headers.authorization)) {
        return json(response, 401, { error: "unauthorized" });
      }
      // Streamable HTTP lets a server decline the optional GET stream; sessions end on their own.
      if (request.method === "GET") return response.writeHead(405, { allow: "POST" }).end();
      if (request.method === "DELETE") return response.writeHead(204).end();
      if (request.method !== "POST") return response.writeHead(405, { allow: "POST" }).end();

      const body = await readBody(request);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const allowed = await this.allowedApps(botId);
      const id = (message as { id?: unknown }).id ?? null;
      if (!allowed || allowed.length === 0) {
        return json(response, 403, { jsonrpc: "2.0", id, error: { code: -32001, message: "Connected apps are off for this bot. Turn them on under its Access settings in Paseo." } });
      }
      const refusal = appCallRefusal(message, allowed, await connectedSlugs());
      if (refusal) return json(response, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: refusal }], isError: true } });

      await this.forward(request, response, body);
    } catch (error) {
      if (!response.headersSent) json(response, 502, { jsonrpc: "2.0", id: null, error: { code: -32002, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async forward(request: IncomingMessage, response: ServerResponse, body: string) {
    const transport = request.headers["mcp-session-id"];
    const send = async (recreate: boolean) => {
      const upstream = await session({ recreate });
      return fetch(upstream.mcpUrl, {
        method: "POST",
        headers: {
          "x-api-key": upstream.apiKey,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(typeof transport === "string" ? { "mcp-session-id": transport } : {}),
          ...(typeof request.headers["mcp-protocol-version"] === "string" ? { "mcp-protocol-version": request.headers["mcp-protocol-version"] } : {}),
        },
        body,
        signal: deadline(10 * 60_000),
      });
    };
    let upstream = await send(false);
    // A Tool Router session Composio no longer knows: open a new one and let the client start over.
    if (upstream.status === 404 && !transport) upstream = await send(true);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_RESPONSE) throw new Error("The connected app's answer is over 20 MB.");
    const next = upstream.headers.get("mcp-session-id");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(next ? { "mcp-session-id": next } : {}),
    });
    response.end(bytes);
  }
}
