import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

/** Every Bots view belongs to one native Paseo sidebar entry. */
export function PaseoBotsSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Bot" label="Bots" active={currentScreen?.screenId === "bots" || currentScreen?.screenId.startsWith("bot-")} onPress={() => openScreen({ screenId: "bots" })} />;
}
