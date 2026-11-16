import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const ServerId = z.string().min(1).max(200);
export const McpOAuthStatusSchema = z.object({
  connected: z.boolean(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  error: z.string().nullable(),
  redirectUrl: z.string(),
  login: z.object({ url: z.string(), expiresAt: z.string() }).nullable(),
});
export type McpOAuthStatus = z.infer<typeof McpOAuthStatusSchema>;

export const mcpOAuthStatusRpc = defineRpc({ name: "bots.mcp-oauth.status", input: z.object({ serverId: ServerId }), output: McpOAuthStatusSchema });
export const mcpOAuthStartRpc = defineRpc({
  name: "bots.mcp-oauth.start",
  input: z.object({ serverId: ServerId, clientId: z.string().max(2048).optional(), clientSecret: z.string().max(8192).optional() }),
  output: McpOAuthStatusSchema,
});
/** Full callback URL preserves state/issuer checks even when the browser runs on another device. */
export const mcpOAuthFinishRpc = defineRpc({ name: "bots.mcp-oauth.finish", input: z.object({ serverId: ServerId, callbackUrl: z.string().min(1).max(16384) }), output: McpOAuthStatusSchema });
export const mcpOAuthCancelRpc = defineRpc({ name: "bots.mcp-oauth.cancel", input: z.object({ serverId: ServerId }), output: McpOAuthStatusSchema });
export const mcpOAuthDisconnectRpc = defineRpc({ name: "bots.mcp-oauth.disconnect", input: z.object({ serverId: ServerId }), output: McpOAuthStatusSchema });
