import type { PluginServerContext } from "@getpaseo/plugin/server";
import { lastTurn } from "../shared/activity";
import { BOT_LABEL } from "../shared/bot";
import { ASKED_BY_LABEL, ASKED_IN_LABEL, HANDOFF_CARD, HandoffCardSchema, handoffStatusRpc, type HandoffCard, type HandoffStatus } from "../shared/handoff";
import type { BotsHost } from "./host";
import type { PaseoApi } from "./paseo";
import { HandoffNotifications } from "./handoff-notifications";

/** A presentation failure must never turn an accepted delegation into a retryable dispatch error. */
export async function publishHandoff(paseo: PaseoApi, card: HandoffCard): Promise<void> {
  try {
    const data = HandoffCardSchema.parse(card);
    await paseo.agents.ref(card.requesterAgentId).timeline.append({ type: "plugin", id: `handoff:${card.targetAgentId}`, ...HANDOFF_CARD, data: { ...data } });
  } catch (error) { console.error("paseo-bots: could not display a bot handoff", error); }
}

/** Only a target created from this exact requester chat can be inspected by a handoff card. */
export async function handoffStatus(host: BotsHost, requesterAgentId: string, targetAgentId: string): Promise<HandoffStatus | null> {
  const paseo = host.requirePaseo();
  const [requester, target] = await Promise.all([paseo.agents.ref(requesterAgentId).refresh(), paseo.agents.ref(targetAgentId).refresh()]);
  if (!requester || !target) return null;
  const requesterBotId = requester.agent.labels?.[BOT_LABEL];
  if (!requesterBotId || !target.agent.labels?.[BOT_LABEL] || target.agent.labels[ASKED_BY_LABEL] !== requesterBotId || target.agent.labels[ASKED_IN_LABEL] !== requesterAgentId) throw new Error("This bot conversation belongs to another request.");
  const page = await paseo.agents.ref(targetAgentId).timeline.refetch({ direction: "tail", projection: "projected", limit: 80 });
  const reply = lastTurn(page.entries.map((entry) => entry.item as { type: string; text?: unknown; name?: unknown })).reply;
  const agent = target.agent;
  return {
    state: agent.archivedAt ? "archived" : agent.pendingPermissions?.length ? "permission" : agent.status === "running" || agent.status === "initializing" ? "running" : agent.status === "error" ? "error" : "finished",
    reply: reply.length > 6000 ? `${reply.slice(0, 5998)}…` : reply,
    error: agent.lastError?.slice(0, 1000) || null,
  };
}

export function registerHandoffs(server: PluginServerContext, host: BotsHost): () => Promise<void> {
  const notifications = new HandoffNotifications(host);
  const retry = () => { if (host.paseo) void notifications.retry().catch((error: unknown) => console.error("paseo-bots: could not retry bot completion updates", error)); };
  const detach = host.onAttach(retry);
  const timer = setInterval(retry, 30_000);
  timer.unref();
  server.addHook("agent.turn.after", async (event, context) => {
    host.attach(context.paseo);
    await notifications.finished(event, context.paseo).catch((error: unknown) => console.error("paseo-bots: could not notify the requesting chat", error));
    retry();
  });
  server.handle(handoffStatusRpc, async ({ requesterAgentId, targetAgentId }, context) => {
    host.attach(context.paseo);
    return { status: await handoffStatus(host, requesterAgentId, targetAgentId) };
  });
  return async () => { clearInterval(timer); detach(); await notifications.stop(); };
}
