import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Other apps on this computer that keep MCP servers in the {"mcpServers": {...}}
// shape: the import sheet offers theirs as JSON to review before adding.

function sources(): { label: string; path: string }[] {
  const home = homedir();
  const os = platform();
  const desktop = os === "darwin" ? join(home, "Library", "Application Support", "Claude") : os === "win32" ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude") : join(home, ".config", "Claude");
  return [
    // User-scoped servers; project ones stay with their projects.
    { label: "Claude Code", path: join(home, ".claude.json") },
    { label: "Claude Desktop", path: join(desktop, "claude_desktop_config.json") },
    { label: "Cursor", path: join(home, ".cursor", "mcp.json") },
  ];
}

/** The MCP servers Claude Code, Claude Desktop and Cursor have here, each app's as `{"mcpServers": {...}}` text. */
export async function mcpSources(): Promise<{ sources: { label: string; count: number; json: string }[] }> {
  const found: { label: string; count: number; json: string }[] = [];
  for (const source of sources()) {
    try {
      const { mcpServers } = JSON.parse(await readFile(source.path, "utf8")) as { mcpServers?: unknown };
      if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) continue;
      const count = Object.keys(mcpServers).length;
      if (count) found.push({ label: source.label, count, json: JSON.stringify({ mcpServers }, null, 2) });
    } catch {
      // Not installed, or not readable.
    }
  }
  return { sources: found };
}
