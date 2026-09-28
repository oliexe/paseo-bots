import { z } from "zod";
import { applyChanges, botDetails, ChangesSchema, providerInfo, readyProvider, resolveChanges, setupOverview, type AppAccountInfo, type ApplyContext } from "../../shared/changes";
import { proposalReply } from "../../shared/proposals";
import { accounts, status } from "../composio";
import type { BotsHost } from "../host";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

// The whole setup, for bots that set things up for the user: get_setup reads it,
// propose_changes puts a batch of changes on a card the user applies.

/** What the host knows that the saved settings don't: providers and connected app accounts. */
async function hostContext(host: BotsHost): Promise<ApplyContext> {
  const snapshot = await host.paseo?.providers.snapshot().catch(() => null);
  let apps: AppAccountInfo[] | null = null;
  if ((await status()).configured) {
    // Accounts go by the names the user gave them, or Composio's word ids; their sign-in (an email) only matches.
    const list = await accounts().catch(() => null);
    apps = list ? list.accounts.map((account) => ({ id: account.id, slug: account.slug, names: [account.alias, account.wordId, account.name].filter((name): name is string => !!name) })) : null;
  }
  return { now: new Date().toISOString(), provider: snapshot ? readyProvider(snapshot.entries) : "", providers: snapshot ? providerInfo(snapshot.entries) : null, accounts: apps };
}

async function readValues(host: BotsHost) {
  const values = await host.values();
  if (!values) throw new Error("The bot settings can't be read right now. Try again in a moment.");
  return values;
}

export const getSetup = defineTool({
  name: "get_setup",
  description:
    "Read the bot setup on this Paseo: the bots, teams, the library of skills and MCP servers, connected apps, what new bots start with, presets, and the providers with their models and approval modes. Name a bot to get everything about it, including its instructions, playbooks and routines. Read it before propose_changes.",
  input: z.object({ bot: z.string().max(100).optional().describe("A bot's name or id, for its full details.") }),
  async run({ bot }, { host }) {
    const values = await readValues(host);
    if (bot) return botDetails(values, bot);
    const context = await hostContext(host);
    return setupOverview(values, context.providers ?? null, context.accounts ?? null);
  },
});

export const proposeChanges = defineTool({
  name: "propose_changes",
  description:
    "Propose changes to the bot setup: create, edit or delete bots (name, instructions, model, approval mode, avatar, skills, MCP servers, connected apps, tool grants, playbooks, routines), teams (members, Chief of Staff, shared instructions, logo), library skills and MCP servers, what new bots start with, and presets. Put every change for one request in one call, in order; later changes can refer to bots and teams created earlier by name. The user reviews them together on a card in this chat and applies or dismisses them. Read get_setup first for the current setup and valid ids.",
  input: z.object({
    summary: z.string().min(1).max(300).describe("One line saying what the changes do, shown on the card."),
    changes: ChangesSchema,
  }),
  async run({ summary, changes }, { bot, agentId, host }) {
    const values = await readValues(host);
    const context = await hostContext(host);
    const resolved = resolveChanges(changes, context);
    // A dry run finds mistakes now, while they can still be fixed; the app applies the changes for real.
    applyChanges(values, resolved, context);
    const proposal = await createProposal({ botId: bot.id, agentId, kind: "changes", data: { summary: summary.trim(), changes: resolved, provider: context.provider } });
    return proposalReply(proposal.id, changes.length === 1 ? "the change" : `these ${changes.length} changes`);
  },
});
