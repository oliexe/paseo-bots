import { listBots } from "./bots";
import type { BotTool } from "./mcp";
import { proposeSkill } from "./skills";

/** Every tool the "bots" MCP server offers, in the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [listBots, proposeSkill];
