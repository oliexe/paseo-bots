import { BOT_LABEL } from "../shared/bot";
import type { PaseoAgent, PaseoApi } from "./paseo";
import { observeChatActivity } from "./chat-activity";
import { orderChats } from "../shared/sidebar";

export type BotChat = PaseoAgent & { activityAt: string };

/** Read every page: the host's default list window is not a bot's entire chat history. */
export async function listBotChats(api: PaseoApi, botId: string, signal?: AbortSignal, host = "local"): Promise<BotChat[]> {
  const agents = new Map<string, PaseoAgent>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (signal?.aborted) throw Object.assign(new Error("Loading chats was canceled."), { name: "AbortError" });
    const result: Awaited<ReturnType<PaseoApi["agents"]["list"]>> = await api.agents.list({
      filter: { labels: { [BOT_LABEL]: botId }, includeBackground: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
      ...(signal ? { signal } : {}),
    });
    for (const { agent } of result.entries) {
      const previous = agents.get(agent.id);
      if (!previous || (Date.parse(agent.updatedAt) || 0) >= (Date.parse(previous.updatedAt) || 0)) agents.set(agent.id, agent);
    }
    cursor = result.pageInfo?.hasMore ? result.pageInfo.nextCursor : null;
    if (result.pageInfo?.hasMore && (!cursor || cursors.has(cursor))) throw new Error("Paseo could not load the next page of chats. Retry the chat list.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return orderChats([...agents.values()].filter((agent) => !agent.archivedAt)
    .map((agent) => ({ ...agent, activityAt: observeChatActivity(host, agent) })), "activity");
}
