import type { PaseoApi } from "./paseo";

/** Public 0.16 stop paths: deny an outstanding permission, otherwise interrupt by reopening the session. */
export async function stopAgent(api: PaseoApi, agentId: string): Promise<void> {
  const agent = api.agents.ref(agentId);
  const snapshot = await agent.refresh();
  if (!snapshot) throw new Error("This chat is no longer available.");
  const permission = snapshot.agent.pendingPermissions[0];
  if (permission) {
    try {
      await agent.respondToPermission({ requestId: permission.id, response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." } });
    } catch (error) {
      // Another client may have answered while Stop was reading the snapshot.
      // Only fall back when that exact request is gone; connection errors stay visible.
      const latest = await agent.refresh().catch(() => null);
      if (!latest || latest.agent.pendingPermissions.some((entry) => entry.id === permission.id)) throw error;
      if (latest.agent.status === "running" || latest.agent.status === "initializing") await agent.reload();
    }
  } else if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") {
    // reload retains the chat's history and reruns session hooks; it does not send a new user message.
    await agent.reload();
  }
}
