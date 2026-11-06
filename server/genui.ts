import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeGenUi from "paseo-plugin-genui/index.server";

/** Register GenUI's RPCs inside Bots so its client components use the same plugin session. */
export function registerGenUiHandlers(server: PluginServerContext): () => void {
  // Bots supplies the inline-UI instructions itself. Keep GenUI's hooks from changing
  // unrelated agents or adding a second render_ui tool to every session on this host.
  const scopedServer = new Proxy(server, {
    get(target, property, receiver) {
      if (property === "before" || property === "on") return () => undefined;
      return Reflect.get(target, property, receiver);
    },
  });
  return contributeGenUi(scopedServer);
}
