import type { PluginHookEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { BOT_LABEL, botMcpServers, toolGrants, type Bot, type Library } from "../shared/bot";
import type { BotsHost } from "./host";
import type { McpOAuthProxy } from "./mcp-oauth-proxy";

export function allowsOAuthTool(bot: Bot, library: Library, request: PluginHookEvents["agent.permission.before"]["request"]): boolean {
  if (request.provider !== "claude" || request.kind !== "tool" || !request.name) return false;
  const servers = botMcpServers(bot, library);
  // Claude's flat MCP name must identify one assigned server unambiguously.
  const candidates = servers.filter((server) => request.name!.startsWith(`mcp__${server.name}__`));
  if (candidates.length !== 1) return false;
  const server = candidates[0]!;
  if (server.config.type === "stdio" || !server.config.oauth) return false;
  return toolGrants(bot.alwaysAllow).some((grant) => !grant.server.includes("__") && !grant.tool.includes("__") && grant.server === server.name && request.name === `mcp__${grant.server}__${grant.tool}`);
}

/** OAuth mounts are launch-only: Paseo rejects a name contributed both here and in saved agent config. */
export function registerMcpOAuthLifecycle(server: PluginServerContext, host: BotsHost, proxy: McpOAuthProxy): void {
  server.addHook("agent.open.before", async ({ request }, context) => {
    host.attach(context.paseo);
    const botId = request.labels[BOT_LABEL];
    if (!botId || request.purpose === "history") return;
    const mounts = await proxy.servers(botId, request.agentId);
    for (const name of Object.keys(mounts)) {
      if (name in request.mcpServers) throw new Error(`MCP server '${name}' conflicts with another plugin. Rename it in Skills & Tools.`);
    }
    return { ...request, mcpServers: { ...request.mcpServers, ...mounts } };
  });
  server.addHook("agent.permission.before", async ({ agent, request }, context) => {
    if (request.provider !== "claude" || request.kind !== "tool") return;
    host.attach(context.paseo);
    const chat = await host.chatOf(agent.id);
    if (!chat) return;
    const values = await host.values();
    const bot = values?.bots.find((entry) => entry.id === chat.botId);
    if (!bot || bot.archived || bot.hostId || !values?.library || !allowsOAuthTool(bot, values.library, request)) return;
    await context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });
}
