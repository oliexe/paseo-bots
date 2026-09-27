// The plugin's own tools, served to every local bot chat as the MCP server
// "bots": other bots, past chats, and proposals (skills, routines, app
// connections) the user confirms in the chat.

export const TOOLS_MCP_NAME = "bots";

export const BOT_TOOL_NAMES = ["list_bots", "ask_bot", "check_chat", "search_chats", "propose_skill", "propose_routine", "connect_app"] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Tools that only read or only propose something the user confirms, so they
 * run without a permission prompt. Asking another bot is left to the bot's
 * "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = ["list_bots", "check_chat", "search_chats", "propose_skill", "propose_routine", "connect_app"];

/**
 * The bot tool a timeline tool call is, whatever the provider calls it:
 * Claude `mcp__bots__ask_bot`, Codex `bots.ask_bot`, others `bots_ask_bot`.
 */
export function botToolName(name: string): BotToolName | null {
  const match = /^(?:mcp__)?bots(?:__|\.|_)([a-z_]+)$/.exec(name.trim());
  const tool = match?.[1];
  return tool && (BOT_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as BotToolName) : null;
}

/** Providers that accept exact MCP tool grants (Paseo refuses the chat for others). */
export function supportsToolGrants(provider: string): boolean {
  return /^(claude|codex|opencode)(\b|$)/.test(provider);
}
