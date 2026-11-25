import { Platform } from "react-native";

interface ActivityAgent {
  id: string;
  createdAt?: string;
  updatedAt: string;
  lastUserMessageAt?: string | null;
  attentionTimestamp?: string | null;
  status?: string;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUsage?: unknown;
}
type Observation = { at: number; turn: string | null; status?: string; usage: string };
const observations = new Map<string, Observation>();
const dates = new Map<string, number>();
const STORAGE_KEY = "paseo-bots:chat-activity:v1";
const LIMIT = 2000;
let loaded = false;
const date = (value?: string | null) => Date.parse(value ?? "") || 0;

function storage() {
  if (Platform.OS !== "web") return undefined;
  try {
    return (globalThis as { sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } }).sessionStorage;
  } catch { return undefined; }
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const entries: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(entries)) for (const entry of entries.slice(-LIMIT)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1]) && entry[1] >= 0) dates.set(entry[0], entry[1]);
    }
  } catch { /* Restricted windows retain their in-memory activity dates. */ }
}

/** Message/turn activity, not the host's general mutation timestamp.
 * Reopening a provider, changing a title or clearing attention can update
 * updatedAt without any conversation activity. Retain completed activity when
 * its attention flag is cleared, including across client module replacement.
 */
export function observeChatActivity(host: string, agent: ActivityAgent): string {
  load();
  const key = JSON.stringify([host, agent.id]);
  const previous = observations.get(key);
  const turn = agent.activeTurn?.turnId ?? null;
  const usage = JSON.stringify(agent.lastUsage ?? null);
  let at = Math.max(dates.get(key) ?? 0, date(agent.createdAt), date(agent.lastUserMessageAt),
    date(agent.attentionTimestamp), date(agent.activeTurn?.startedAt));
  // Only use updatedAt when a real execution signal changed. A provider opening
  // closed -> initializing -> idle has neither an active turn nor a running finish.
  const finished = previous && (previous.turn || previous.status === "running") && !turn && agent.status !== "running";
  const progressed = previous && turn && previous.turn === turn && previous.usage !== usage;
  if (finished || progressed) at = Math.max(at, date(agent.updatedAt));
  observations.delete(key);
  observations.set(key, { at, turn, status: agent.status, usage });
  const changed = dates.get(key) !== at;
  dates.delete(key);
  dates.set(key, at);
  if (dates.size > LIMIT) dates.delete(dates.keys().next().value!);
  if (observations.size > LIMIT) observations.delete(observations.keys().next().value!);
  if (changed) try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...dates])); } catch { /* Optional cache. */ }
  return new Date(at).toISOString();
}
