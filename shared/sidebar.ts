// Pure sidebar logic, ported from Paseo so the bot list reads its chats the same
// way Paseo's sidebar reads workspaces (protocol/agent-state-bucket.ts,
// utils/sidebar-agent-state.ts, hooks/sidebar-workspaces-view-model.ts).

/** Paseo's sidebar status buckets, most urgent first. */
export type ChatBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export interface ChatBucketInput {
  status: string;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
}

/** deriveAgentStateBucket: permission beats error beats running; initializing is not running. */
export function chatBucket(agent: ChatBucketInput): ChatBucket {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running") return "running";
  if (agent.requiresAttention) return "attention";
  return "done";
}

/**
 * Collapsed-group priority (STATUS_BUCKET_PRIORITY): unlike the listing order,
 * running outranks attention so a working bot keeps its ring.
 */
const AGGREGATE_PRIORITY: readonly ChatBucket[] = ["needs_input", "failed", "running", "attention", "done"];

export function aggregateBuckets(buckets: Iterable<ChatBucket>): ChatBucket {
  let best = AGGREGATE_PRIORITY.length - 1;
  for (const bucket of buckets) {
    const rank = AGGREGATE_PRIORITY.indexOf(bucket);
    if (rank !== -1 && rank < best) best = rank;
  }
  return AGGREGATE_PRIORITY[best] ?? "done";
}

export const BUCKET_LABELS: Record<ChatBucket, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Ready to review",
  running: "Working",
  done: "Done",
};

/** Paseo's useLimitedSidebarGroup: groups longer than this get "Show more". */
export const SIDEBAR_GROUP_LIMIT = 20;

/**
 * Paseo's applyStoredOrdering: items keep their base order, except that the
 * items named in `storedOrder` fill their own slots in the stored order. New
 * items therefore appear where the base order puts them and never reshuffle
 * the ones the user arranged.
 */
export function applyStoredOrdering<T>(items: readonly T[], storedOrder: readonly string[], getKey: (item: T) => string): T[] {
  if (items.length <= 1 || storedOrder.length === 0) return [...items];
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(getKey(item), item);
  const pruned: string[] = [];
  const seen = new Set<string>();
  for (const key of storedOrder) {
    if (!byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    pruned.push(key);
  }
  if (pruned.length === 0) return [...items];
  const ordered: T[] = [];
  let index = 0;
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      ordered.push(item);
      continue;
    }
    const target = pruned[index] ?? key;
    index += 1;
    ordered.push(byKey.get(target) ?? item);
  }
  return ordered;
}

export type ChatSort = "manual" | "activity";

export interface OrderableChat {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Chat order within a bot. "manual" starts from newest-created first and
 * applies the stored order, so rows don't jump when a chat gets a reply;
 * "activity" is most recently updated first.
 */
export function orderChats<T extends OrderableChat>(chats: readonly T[], sort: ChatSort, storedOrder: readonly string[] = []): T[] {
  if (sort === "activity") return [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const base = [...chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return applyStoredOrdering(base, storedOrder, (chat) => chat.id);
}

/** Moves `key` one step within `keys` (the full visible order). Returns null at an edge or when missing. */
export function moveKey(keys: readonly string[], key: string, delta: -1 | 1): string[] | null {
  const index = keys.indexOf(key);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= keys.length) return null;
  const next = [...keys];
  next[index] = keys[target]!;
  next[target] = key;
  return next;
}
