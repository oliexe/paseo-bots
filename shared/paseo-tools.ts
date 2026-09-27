// Paseo's own tools (agents, workspaces, terminals, schedules, the browser)
// reach every agent through an MCP server the daemon adds at launch, named
// "paseo". Whether it's added is host configuration, not part of the agent
// request, so bots get it exactly like any other Paseo agent.

/** The server name Paseo adds; a library server with this name would replace it. */
export const PASEO_MCP_NAME = "paseo";

/** The daemon config fields that decide whether agents get Paseo's tools. */
export interface PaseoToolsConfig {
  mcp?: { enabled?: boolean; injectIntoAgents?: boolean };
  providers?: Record<string, { paseoTools?: { enabled?: boolean; disabledTools?: string[] } } | undefined>;
}

export type PaseoToolsState =
  | { on: true; disabledTools: string[] }
  /** "mcp": the daemon's MCP endpoint is off; "host": agents don't get it; "provider": turned off for this provider. */
  | { on: false; reason: "mcp" | "host" | "provider" };

/** Mirrors agent-manager.ts: the endpoint on, injection on, and the provider's policy not disabled. */
export function paseoToolsState(config: PaseoToolsConfig, provider: string): PaseoToolsState {
  if (config.mcp?.enabled === false) return { on: false, reason: "mcp" };
  if (config.mcp?.injectIntoAgents === false) return { on: false, reason: "host" };
  const policy = config.providers?.[provider]?.paseoTools;
  if (policy?.enabled === false) return { on: false, reason: "provider" };
  return { on: true, disabledTools: policy?.disabledTools ?? [] };
}

export const PASEO_TOOLS_PROMPT =
  'You run inside Paseo, and Paseo\'s own tools are available to you through its MCP server "paseo": start and message other agents, create workspaces, use terminals, set up schedules and drive a browser. Use them when a request is about work in Paseo or needs another agent, and say what you started.';
