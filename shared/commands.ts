// Commands a bot may run without asking are matched exactly (command and
// folder), like OpenMausBot's command allowlist.

/** The shell command a permission request is about and the folder it runs in, if it's one. */
export function shellCommand(request: { detail?: unknown }, fallbackCwd: string): { command: string; cwd: string } | null {
  const detail = request.detail as { type?: unknown; command?: unknown; cwd?: unknown } | undefined;
  if (detail?.type !== "shell" || typeof detail.command !== "string") return null;
  return { command: detail.command, cwd: typeof detail.cwd === "string" && detail.cwd ? detail.cwd : fallbackCwd };
}
