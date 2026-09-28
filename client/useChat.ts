import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeEntries } from "./chat/stream/model";

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type ChatEntry = TimelinePage["entries"][number];
type Cursor = NonNullable<TimelinePage["endCursor"]>;

export interface ChatState {
  entries: ChatEntry[];
  agent: PaseoAgent | null;
  /** The first page hasn't arrived yet. */
  loading: boolean;
  /** The last timeline sync failed; `retry()` tries again. */
  error: string | null;
  /** Older history exists before the first entry we hold. */
  hasOlder: boolean;
  loadingOlder: boolean;
  retrying: boolean;
  /** Loads the previous page of history (Paseo pages 40 projected items). */
  loadOlder(): void;
  retry(): void;
}

/** Paseo's TIMELINE_FETCH_PAGE_SIZE (timeline/timeline-fetch-policy.ts). */
const TIMELINE_PAGE_SIZE = 40;

/** A chat's whole timeline, oldest first, page by page (a transcript needs all of it). */
export async function fullTimeline(api: PaseoApi, agentId: string): Promise<ChatEntry[]> {
  const handle = api.agents.ref(agentId);
  let page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 200 });
  if (page.error) throw new Error(page.error);
  let entries = page.entries;
  for (let pages = 0; pages < 100 && page.hasOlder && page.startCursor; pages++) {
    page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected", limit: 200 });
    if (page.error) throw new Error(page.error);
    if (page.entries.length === 0) break;
    entries = mergeEntries(entries, page.entries);
  }
  return entries;
}

const noop = () => {};
const EMPTY: ChatState = { entries: [], agent: null, loading: false, error: null, hasOlder: false, loadingOlder: false, retrying: false, loadOlder: noop, retry: noop };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live chat state for one agent, synced the way Paseo's timeline sync does it:
 * the tail page once, then only what's new ("after" the end cursor) on each live
 * event, merged by the projected entry's first seq. Older pages load on demand.
 */
export function useChat(api: PaseoApi | null, agentId: string | null): ChatState {
  const [state, setState] = useState<ChatState>(EMPTY);
  const actions = useRef<{ loadOlder(): void; retry(): void }>({ loadOlder: noop, retry: noop });

  useEffect(() => {
    if (!api || !agentId) {
      setState(EMPTY);
      actions.current = { loadOlder: noop, retry: noop };
      return;
    }
    setState({ ...EMPTY, loading: true });
    const handle = api.agents.ref(agentId);
    let disposed = false;
    let endCursor: Cursor | null = null;
    let startCursor: Cursor | null = null;
    let busy = false;
    let queued: "tail" | "after" | null = null;
    let olderBusy = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const agentFrom = (page: TimelinePage, current: PaseoAgent | null) => (page.agent as PaseoAgent | null) ?? handle.current() ?? current;

    const sync = async (mode: "tail" | "after"): Promise<void> => {
      if (busy) {
        if (queued !== "tail") queued = mode;
        return;
      }
      busy = true;
      try {
        let replace = mode === "tail" || endCursor === null;
        for (let pages = 0; pages < 25 && !disposed; pages++) {
          const page = replace
            ? await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: TIMELINE_PAGE_SIZE })
            : await handle.timeline.refetch({ direction: "after", cursor: endCursor!, projection: "projected", limit: TIMELINE_PAGE_SIZE });
          if (disposed) return;
          if (page.error) throw new Error(page.error);
          // A new epoch or a gap means our cursor no longer lines up: the page is a fresh tail.
          const reset = replace || page.reset || page.staleCursor || page.gap;
          if (page.endCursor) endCursor = page.endCursor;
          if (reset) {
            startCursor = page.startCursor;
          }
          setState((current) => ({
            ...current,
            entries: reset ? page.entries : mergeEntries(current.entries, page.entries),
            agent: agentFrom(page, current.agent),
            loading: false,
            error: null,
            retrying: false,
            hasOlder: reset ? page.hasOlder : current.hasOlder,
          }));
          if (!page.hasNewer || page.entries.length === 0) break;
          replace = false;
        }
      } catch (error) {
        if (!disposed) setState((current) => ({ ...current, loading: false, retrying: false, error: message(error) }));
      } finally {
        busy = false;
        if (queued && !disposed) {
          const next = queued;
          queued = null;
          void sync(next);
        }
      }
    };

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void sync("after");
      }, 80);
    };

    const loadOlder = () => {
      if (olderBusy || !startCursor || disposed) return;
      olderBusy = true;
      setState((current) => (current.hasOlder ? { ...current, loadingOlder: true } : current));
      void handle.timeline
        .refetch({ direction: "before", cursor: startCursor, projection: "projected", limit: TIMELINE_PAGE_SIZE })
        .then((page) => {
          if (disposed) return;
          if (page.error) throw new Error(page.error);
          if (page.staleCursor || page.reset) {
            setState((current) => ({ ...current, loadingOlder: false }));
            void sync("tail");
            return;
          }
          if (page.startCursor) startCursor = page.startCursor;
          setState((current) => ({
            ...current,
            entries: mergeEntries(current.entries, page.entries),
            hasOlder: page.hasOlder && page.entries.length > 0,
            loadingOlder: false,
          }));
        })
        .catch((error: unknown) => {
          if (!disposed) setState((current) => ({ ...current, loadingOlder: false, error: message(error) }));
        })
        .finally(() => {
          olderBusy = false;
        });
    };

    const retry = () => {
      setState((current) => ({ ...current, retrying: true }));
      void sync(endCursor ? "after" : "tail");
    };
    actions.current = { loadOlder, retry };

    const timeline = handle.timeline.subscribe((event) => {
      const kind = (event as { event?: { type?: string } }).event?.type;
      if (kind === "replacement") void sync("tail");
      else schedule();
    });
    void sync("tail");
    const unsubscribeAgent = handle.subscribe(() => {
      const snapshot = handle.current();
      if (snapshot && !disposed) setState((current) => ({ ...current, agent: snapshot }));
    });
    void handle
      .refresh()
      .then((result) => {
        if (result && !disposed) setState((current) => ({ ...current, agent: result.agent }));
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timeline();
      unsubscribeAgent();
    };
  }, [api, agentId]);

  const loadOlder = useCallback(() => actions.current.loadOlder(), []);
  const retry = useCallback(() => actions.current.retry(), []);
  return { ...state, loadOlder, retry };
}
