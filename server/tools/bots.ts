import { z } from "zod";
import { defineTool } from "./mcp";

// Other bots on this host: who they are, so a bot can hand work to the right one.

export const listBots = defineTool({
  name: "list_bots",
  description: "List the other bots on this Paseo host: id, name, what each does. Use it before asking another bot for help.",
  input: z.object({}),
  async run(_args, { bot, host }) {
    const others = (await host.bots()).filter((entry) => entry.id !== bot.id && !entry.archived);
    if (others.length === 0) return "There are no other bots.";
    return others
      .map((entry) => {
        const about = [entry.title, entry.description].filter((part) => part.trim()).join(" — ");
        return `- ${entry.name} (id: ${entry.id})${about ? `: ${about}` : ""}`;
      })
      .join("\n");
  },
});
