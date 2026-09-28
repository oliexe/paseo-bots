import type { getPaseoClient } from "@getpaseo/plugin/client";

// Paseo's client API types, read off the plugin SDK. Plugins get the API from the host,
// and Paseo builds a plugin without its dev dependencies, so @getpaseo/client can't be
// imported, not even for types.

export type PaseoApi = ReturnType<typeof getPaseoClient>;
type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
export type PaseoAgent = Exclude<Parameters<PaseoApi["agents"]["ref"]>[0], string>;
export type PaseoAgentSendOptions = NonNullable<Parameters<PaseoAgentHandle["send"]>[1]>;
export type PaseoAgentPermissionResponse = Parameters<PaseoAgentHandle["respondToPermission"]>[0]["response"];
