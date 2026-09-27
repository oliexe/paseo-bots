import { listBots } from "./bots";
import { searchChats } from "./chats";
import type { BotTool } from "./mcp";
import { proposeRoutine } from "./routines";
import { proposeSkill } from "./skills";

/** Every tool the "bots" MCP server offers, in the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [listBots, searchChats, proposeSkill, proposeRoutine];
