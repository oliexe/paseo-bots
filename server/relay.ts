import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkAppCall, type AppLimit } from "../shared/apps";
import type { Bot, McpServerConfig } from "../shared/bot";
import { accounts, appTools, connectedSlugs, deadline, readState, session, writeState } from "./composio";
import type { BotsHost } from "./host";
import { answerMcp, type BotTool } from "./tools/mcp";

// Bots reach the plugin through this loopback relay, the way Paseo gives agents
// its own tools: http MCP servers on 127.0.0.1 with a bearer token each chat
// gets in its config. Tokens are signed with a secret only this process knows.
//
//   /mcp/<botId>              connected apps: forwards to Composio with the key
//                             added, after checking the bot may use the app
//   /bots/<botId>/<agentId>   the plugin's own tools for one chat

const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const ID = /^[a-z0-9-]+$/;

function sign(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(subject).digest("hex");
}

/** Connected-apps token; unchanged from the first release so running chats keep working. */
function botToken(secret: string, botId: string): string {
  return sign(secret, botId);
}

function toolsToken(secret: string, botId: string, agentId: string): string {
  return sign(secret, `tools:${botId}:${agentId}`);
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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

/** Extra routes other features add (webhooks). Return true when handled. */
export type RelayRoute = (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>;

/** A bot's limits on its apps, with the read-only tools and the pinned accounts' aliases looked up. */
async function appLimits(bot: Bot): Promise<Map<string, AppLimit>> {
  const limits = new Map<string, AppLimit>();
  for (const slug of bot.apps) {
    const rule = bot.appRules[slug];
    if (!rule || (rule.tools === "all" && !rule.account)) continue;
    const tools = rule.tools === "all" ? null : rule.tools === "read" ? (await appTools({ slug })).tools.filter((tool) => tool.readOnly).map((tool) => tool.slug) : rule.tools;
    const alias = rule.account ? ((await accounts()).accounts.find((account) => account.id === rule.account)?.alias ?? null) : null;
    limits.set(slug, { tools: tools && new Set(tools.map((tool) => tool.toUpperCase())), account: rule.account ? { id: rule.account, alias } : null });
  }
  return limits;
}

export class Relay {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly routes: RelayRoute[] = [];

  constructor(
    private readonly host: BotsHost,
    private readonly tools: readonly BotTool[],
  ) {}

  addRoute(route: RelayRoute): void {
    this.routes.push(route);
  }

  /** Starts listening, on the previous port when it's free so running chats keep their URLs. */
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

  /** The connected-apps server for a bot's chats, or null when connected apps aren't set up. */
  async mountApps(botId: string): Promise<McpServerConfig | null> {
    const state = await readState();
    if (!state.apiKey) return null;
    const port = await this.start();
    return { type: "http", url: `http://127.0.0.1:${port}/mcp/${botId}`, headers: { Authorization: `Bearer ${botToken(state.secret, botId)}` } };
  }

  /** The plugin's tools for one chat. */
  async mountTools(botId: string, agentId: string): Promise<McpServerConfig> {
    const state = await readState();
    const port = await this.start();
    return { type: "http", url: `http://127.0.0.1:${port}/bots/${botId}/${agentId}`, headers: { Authorization: `Bearer ${toolsToken(state.secret, botId, agentId)}` } };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const apps = /^\/mcp\/([^/]+)$/.exec(path);
      if (apps) return await this.handleApps(request, response, apps[1]!);
      const tools = /^\/bots\/([^/]+)\/([^/]+)$/.exec(path);
      if (tools) return await this.handleTools(request, response, tools[1]!, tools[2]!);
      for (const route of this.routes) if (await route(request, response, path)) return;
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) json(response, 502, { jsonrpc: "2.0", id: null, error: { code: -32002, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /** Streamable HTTP lets a server decline the optional GET stream; sessions end on their own. */
  private refuseNonPost(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method === "POST") return false;
    if (request.method === "DELETE") response.writeHead(204).end();
    else response.writeHead(405, { allow: "POST" }).end();
    return true;
  }

  private async parse(request: IncomingMessage, response: ServerResponse): Promise<{ body: string; message: Record<string, unknown> } | null> {
    const body = await readBody(request);
    try {
      return { body, message: JSON.parse(body) as Record<string, unknown> };
    } catch {
      json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return null;
    }
  }

  private async handleTools(request: IncomingMessage, response: ServerResponse, botId: string, agentId: string) {
    const state = await readState();
    if (!ID.test(botId) || !ID.test(agentId) || !tokenMatches(toolsToken(state.secret, botId, agentId), request.headers.authorization)) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived) return json(response, 403, { jsonrpc: "2.0", id, error: { code: -32001, message: "This bot no longer exists." } });
    const answer = await answerMcp(parsed.message, this.tools, { bot, agentId, host: this.host, relay: this });
    if (!answer) return response.writeHead(202).end();
    json(response, 200, answer);
  }

  private async handleApps(request: IncomingMessage, response: ServerResponse, botId: string) {
    const state = await readState();
    if (!ID.test(botId) || !tokenMatches(botToken(state.secret, botId), request.headers.authorization)) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived || bot.hostId || bot.apps.length === 0) {
      return json(response, 403, { jsonrpc: "2.0", id, error: { code: -32001, message: "Connected apps are off for this bot. Turn them on under its Access settings in Paseo." } });
    }
    // Limits need Composio's tool lists, so they're looked up for tool calls only.
    const limits = parsed.message.method === "tools/call" ? await appLimits(bot) : new Map<string, AppLimit>();
    const verdict = checkAppCall(parsed.message, { allowed: bot.apps, connected: await connectedSlugs(), limits });
    if ("refusal" in verdict) return json(response, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: verdict.refusal }], isError: true } });
    await this.forward(request, response, verdict.message === parsed.message ? parsed.body : JSON.stringify(verdict.message));
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
