import { askBot, checkChat, listBots } from "./bots";
import { searchChats } from "./chats";
import type { BotTool } from "./mcp";
import { cancelRoutineRun, listRoutines, proposeRoutine, runRoutine } from "./routines";
import { getSetup, proposeChanges } from "./setup";
import { proposeSkill } from "./skills";
import { showCard } from "./interactions";

/** Every tool the "bots" MCP server offers, in the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [listBots, askBot, checkChat, searchChats, getSetup, proposeSkill, proposeRoutine, listRoutines, runRoutine, cancelRoutineRun, proposeChanges, showCard];
