import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { ensureBotHome, ensureBotsHome } from "./server/bot-home";
import { deleteMemory, listMemory, readMemory, writeMemory } from "./server/memory";
import { systemPrompt } from "./server/prompt";
import { RoutineScheduler } from "./server/scheduler";
import { exportBot, importBot } from "./server/share";
import { deleteSkill, importSkills, migrateBotSkills, readSkill, writeSkill } from "./server/library";
import { probeMcpServer } from "./server/mcp-probe";
import { accounts, catalog, connect, disconnect, removeKey, setKey, status as appsStatus } from "./server/composio";
import { AppsRelay } from "./server/relay";
import { saveUpload } from "./server/uploads";
import { botSettings, EMPTY_LIBRARY } from "./shared/bot";
import {
  ensureBotHomeRpc,
  exportBotRpc,
  helloRpc,
  importBotRpc,
  memoryDeleteRpc,
  memoryListRpc,
  memoryReadRpc,
  memoryWriteRpc,
  mcpProbeRpc,
  appsAccountsRpc,
  appsCatalogRpc,
  appsConnectRpc,
  appsDisconnectRpc,
  appsMountRpc,
  appsRemoveKeyRpc,
  appsSetKeyRpc,
  appsStatusRpc,
  routineRunNowRpc,
  routineStatusRpc,
  skillDeleteRpc,
  skillImportRpc,
  skillReadRpc,
  skillWriteRpc,
  systemPromptRpc,
  uploadRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  // Moves the old folder if needed and writes the Bots project icon.
  void ensureBotsHome()
    .then(migrateBotSkills)
    .catch((error: unknown) => console.error("paseo-bot: couldn't prepare the Bots folder", error));
  const settings = server.registerSettings(botSettings);
  const library = async () => {
    const state = await settings.read();
    return state.status === "ready" ? (state.values.library ?? EMPTY_LIBRARY) : EMPTY_LIBRARY;
  };
  // Connected apps: the relay checks each bot's allowed apps against the saved settings on every call.
  const relay = new AppsRelay(async (botId) => {
    const state = await settings.read();
    const bot = state.status === "ready" ? state.values.bots.find((entry) => entry.id === botId) : undefined;
    return bot && !bot.archived && !bot.hostId ? bot.apps : null;
  });
  void relay.start().catch((error: unknown) => console.error("paseo-bot: couldn't start the connected-apps relay", error));
  const scheduler = new RoutineScheduler(settings, relay);
  // Every handler and hook receives the plugin's Paseo API; the scheduler needs it to start chats.
  const attach = ({ paseo }: PluginHandlerContext) => scheduler.attach(paseo);

  server.handle(helloRpc, (_input, context) => {
    attach(context);
    return { scheduler: scheduler.running };
  });
  server.handle(ensureBotHomeRpc, (input, context) => {
    attach(context);
    return ensureBotHome(input);
  });
  server.handle(systemPromptRpc, async (input, context) => systemPrompt(input, await library(), context.paseo));
  server.handle(memoryListRpc, ({ botId }) => listMemory(botId));
  server.handle(memoryReadRpc, ({ botId, name }) => readMemory(botId, name));
  server.handle(memoryWriteRpc, ({ botId, name, text }) => writeMemory(botId, name, text));
  server.handle(memoryDeleteRpc, ({ botId, name }) => deleteMemory(botId, name));
  server.handle(skillImportRpc, importSkills);
  server.handle(skillReadRpc, readSkill);
  server.handle(skillWriteRpc, writeSkill);
  server.handle(skillDeleteRpc, deleteSkill);
  server.handle(mcpProbeRpc, probeMcpServer);
  server.handle(appsStatusRpc, () => appsStatus());
  server.handle(appsSetKeyRpc, setKey);
  server.handle(appsRemoveKeyRpc, () => removeKey());
  server.handle(appsCatalogRpc, () => catalog());
  server.handle(appsAccountsRpc, accounts);
  server.handle(appsConnectRpc, connect);
  server.handle(appsDisconnectRpc, disconnect);
  server.handle(appsMountRpc, async ({ botId }) => ({ server: await relay.mount(botId) }));
  server.handle(routineStatusRpc, (_input, context) => {
    attach(context);
    return scheduler.status();
  });
  server.handle(routineRunNowRpc, ({ botId, routineId }, context) => {
    attach(context);
    return scheduler.runNow(botId, routineId);
  });
  server.handle(exportBotRpc, async (input) => exportBot(input, await library()));
  server.handle(importBotRpc, importBot);
  server.handle(uploadRpc, saveUpload);
  server.on("agent.turn_ended", (_event, context) => scheduler.attach(context.paseo));

  return () => {
    scheduler.stop();
    relay.stop();
  };
}
