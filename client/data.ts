import { getPaseoClient, usePaseo, useHosts } from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { BOT_LABEL } from "../shared/bot";
import { paseoToolsState, type PaseoToolsConfig } from "../shared/paseo-tools";

export interface LocalHost {
  id: string;
  label: string;
}

export interface BotHost {
  api: PaseoApi | null;
  /** Stable key for queries; the local host uses its own id. */
  key: string;
  label: string;
  isLocal: boolean;
  online: boolean;
}

type HostSummaries = ReturnType<typeof useHosts>;

function resolveHost(hostId: string | null, local: LocalHost, localApi: PaseoApi, hosts: HostSummaries): BotHost {
  if (!hostId || hostId === local.id) {
    return { api: localApi, key: local.id, label: local.label, isLocal: true, online: true };
  }
  const summary = hosts.find((host) => host.serverId === hostId);
  const label = summary?.label ?? "Unknown host";
  if (summary?.status !== "online") return { api: null, key: hostId, label, isLocal: false, online: false };
  try {
    return { api: getPaseoClient(hostId), key: hostId, label, isLocal: false, online: true };
  } catch {
    return { api: null, key: hostId, label, isLocal: false, online: false };
  }
}

/** Resolves the host a bot runs on. `hostId === null` is the host that stores the bots. */
export function useBotHost(hostId: string | null, local: LocalHost): BotHost {
  const localApi = usePaseo();
  const hosts = useHosts();
  const summary = hostId ? hosts.find((host) => host.serverId === hostId) : undefined;
  const status = summary?.status;
  return useMemo(
    () => resolveHost(hostId, local, localApi, hosts),
    // Only the fields that change the result.
    [hostId, local.id, local.label, localApi, summary?.label, status],
  );
}

/** The same resolution outside render, e.g. for menu actions. */
export function useHostResolver(local: LocalHost): (hostId: string | null) => BotHost {
  const localApi = usePaseo();
  const hosts = useHosts();
  return (hostId) => resolveHost(hostId, local, localApi, hosts);
}

export function useProviders(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "providers", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await host.api!.providers.snapshot();
      return snapshot.entries.filter((entry) => entry.enabled);
    },
  });
}

export function useAgentProfiles(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "profiles", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => (await host.api!.config.get()).config.agentProfiles ?? [],
  });
}

export function useHostWorkspaces(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "workspaces", host.key],
    enabled: !!host.api,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await host.api!.workspaces.list();
      return result.entries.map((workspace) => ({
        id: workspace.id,
        label: workspace.title || `${workspace.projectDisplayName} · ${workspace.name}`,
        directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
      }));
    },
  });
}

export function useBotChats(host: BotHost, botId: string) {
  return useQuery({
    queryKey: ["paseo-bots", "chats", host.key, botId],
    enabled: !!host.api,
    // The local host pushes agent updates (useChatInvalidation); other hosts are polled.
    refetchInterval: host.isLocal ? false : 15_000,
    queryFn: async (): Promise<PaseoAgent[]> => {
      const result = await host.api!.agents.list({ filter: { labels: { [BOT_LABEL]: botId } } });
      return result.entries
        .map((entry) => entry.agent)
        .filter((agent) => !agent.archivedAt)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  });
}

/** Refetches chat lists shortly after any agent update, so chats routines start show up too. */
export function useChatInvalidation() {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let subscription: { release(): Promise<void> } | null = null;
    const unsubscribe = paseo.agents.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats"] });
      }, 500);
    });
    // The daemon only sends agent updates to sessions that subscribed through a list request.
    void paseo.agents
      .list({ page: { limit: 1 }, subscribe: {} })
      .then((result) => {
        if (closed) void result.subscription.release();
        else subscription = result.subscription;
      })
      .catch(() => {});
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      void subscription?.release();
    };
  }, [paseo, queryClient]);
}

/** The host's Paseo-tools settings for a provider, and a way to turn them on. */
export function usePaseoTools(host: BotHost, provider: string) {
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "paseo-tools", host.key];
  const config = useQuery({
    queryKey: key,
    enabled: !!host.api,
    staleTime: 30_000,
    queryFn: async () => (await host.api!.config.get()).config as PaseoToolsConfig,
  });
  const state = config.data ? paseoToolsState(config.data, provider) : null;
  const turnOn = async () => {
    if (!host.api || !state || state.on) return;
    await host.api.config.patch(state.reason === "provider" ? { providers: { [provider]: { paseoTools: { enabled: true } } } } : { mcp: { injectIntoAgents: true } });
    await queryClient.invalidateQueries({ queryKey: key });
  };
  return { state, loading: config.isLoading, turnOn };
}
