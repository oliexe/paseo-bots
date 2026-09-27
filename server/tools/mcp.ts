import { z, type ZodType } from "zod";
import type { Bot } from "../../shared/bot";
import type { BotToolName } from "../../shared/bot-tools";
import { PLUGIN_VERSION } from "../../shared/version";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";

// A minimal MCP server over streamable HTTP: stateless JSON-RPC with JSON
// answers, enough for initialize, tools/list and tools/call. Each request
// comes from one bot's chat, identified by the relay from its URL and token.

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolCaller {
  bot: Bot;
  /** The chat (agent) the call came from. */
  agentId: string;
  host: BotsHost;
  /** Starts other bots' chats with their tools. */
  relay: Relay;
}

export interface BotTool<Schema extends ZodType = ZodType> {
  name: BotToolName;
  description: string;
  input: Schema;
  /** Whether this bot gets the tool at all (for example, only with other bots to ask). */
  available?(caller: ToolCaller): boolean | Promise<boolean>;
  run(args: z.output<Schema>, caller: ToolCaller): Promise<string>;
}

export function defineTool<Schema extends ZodType>(tool: BotTool<Schema>): BotTool {
  return tool as unknown as BotTool;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

function inputSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

/** Answers one JSON-RPC message; null for notifications, which get no answer. */
export async function answerMcp(message: JsonRpcRequest, tools: readonly BotTool[], caller: ToolCaller): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  if (message.id === undefined || message.id === null) {
    // Notifications (notifications/initialized, cancellations) need no reply.
    if (message.method?.startsWith("notifications/")) return null;
  }
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  const offered = async () => {
    const list: BotTool[] = [];
    for (const tool of tools) if (!tool.available || (await tool.available(caller))) list.push(tool);
    return list;
  };

  switch (message.method) {
    case "initialize": {
      const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION;
      return ok({ protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paseo-bots", version: PLUGIN_VERSION } });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: (await offered()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.input) })) });
    case "tools/call": {
      const tool = (await offered()).find((entry) => entry.name === message.params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${String(message.params?.name)}`);
      const parsed = tool.input.safeParse(message.params?.arguments ?? {});
      if (!parsed.success) return ok({ content: [{ type: "text", text: `Invalid arguments. ${issues(parsed.error)}` }], isError: true });
      try {
        return ok({ content: [{ type: "text", text: await tool.run(parsed.data, caller) }] });
      } catch (error) {
        return ok({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(message.method)}`);
  }
}
