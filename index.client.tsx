import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { BotsSurface } from "./client/BotsSurface";
import { SkillProposalCard } from "./client/chat/stream/SkillProposalCard";
import { requestIntent } from "./client/intent";
import { BOT_LABEL } from "./shared/bot";
import { skillProposalId } from "./shared/proposals";
import { helloRpc } from "./shared/rpc";
import { LEARN_COMMAND, learnPrompt } from "./shared/skills";

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
  // Bot chats opened in Paseo's own agent view get the same /learn and skill cards.
  client.addSlashCommand({
    ...LEARN_COMMAND,
    context: "agent",
    async onSubmit({ agent, args, paseo }) {
      if (!agent.labels[BOT_LABEL]) throw new Error("/learn works in bot chats.");
      await paseo.agents.ref(agent.id).send(learnPrompt(args));
    },
  });
  client.addTimelineTransformer({
    id: "skill-proposals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const proposalId = skillProposalId(item);
      return proposalId ? { items: [{ type: "plugin", kind: "skill-proposal", version: 1, data: { proposalId } }] } : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: "skill-proposal",
    version: 1,
    schema: z.object({ proposalId: z.string() }),
    Component: ({ item, theme, layout }) => <SkillProposalCard colors={theme.colors} compact={layout.compact} proposalId={item.data.proposalId} />,
  });
  return () => {};
}
