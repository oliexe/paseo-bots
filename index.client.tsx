import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotsSurface } from "./client/BotsSurface";
import { requestIntent } from "./client/intent";
import { helloRpc } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  // Hands the daemon side its Paseo API so bot routines can run.
  void client.rpc(helloRpc, {}).catch(() => {});
  client.addSurface("bots", BotsSurface);
  client.addSidebarItem({ id: "bots", title: "Bots", icon: "Bot", surface: "bots" });
  client.addCommandCenterItem({
    id: "open-bots",
    title: "Open Bots",
    icon: "Bot",
    keywords: ["bot", "assistant", "persona"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("bots");
    },
  });
  client.addCommandCenterItem({
    id: "new-bot",
    title: "New bot",
    icon: "Plus",
    keywords: ["bot", "create", "assistant"],
    context: "global",
    onSelect({ openSurface }) {
      requestIntent({ kind: "new-bot" });
      openSurface("bots");
    },
  });
  return () => {};
}
