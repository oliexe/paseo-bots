import type { ToolCallDetail } from "./tools";

export interface ToolSource { title: string; url: string; domain: string; description?: string }

/** A result is navigable only after a user clicks it; never load a remote preview automatically. */
export function toolSource(input: { url: unknown; title?: unknown; description?: unknown } | null | undefined): ToolSource | null {
  if (!input || typeof input !== "object" || typeof input.url !== "string" || input.url.length > 4096) return null;
  try {
    const url = new URL(input.url.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 300) : url.hostname.replace(/^www\./, "");
    const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 600) : undefined;
    return { title, url: url.href, domain: url.hostname.replace(/^www\./, ""), ...(description ? { description } : {}) };
  } catch { return null; }
}

/** Known provider detail types plus bounded structured search results from MCP providers. */
export function extractToolSources(detail: ToolCallDetail, toolName = ""): ToolSource[] {
  if (!detail || typeof detail !== "object") return [];
  const sources: ToolSource[] = [];
  const seen = new Set<string>();
  const add = (value: { url: unknown; title?: unknown; description?: unknown }) => {
    const source = toolSource(value);
    if (!source || sources.length >= 20) return;
    const key = source.url.replace(/#.*$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  if (detail.type === "search" && Array.isArray(detail.webResults)) for (const result of detail.webResults.slice(0, 100)) add(result);
  if (detail.type === "fetch") add({ url: detail.url });
  if (detail.type === "unknown" && /(?:search|fetch|browse|web|read_url)/i.test(toolName)) {
    let visited = 0;
    const visit = (value: unknown, depth: number) => {
      if (depth > 8 || ++visited > 200 || sources.length >= 20) return;
      if (typeof value === "string") {
        if (value.length <= 200_000 && /^[\s]*[\[{]/.test(value)) {
          try { visit(JSON.parse(value), depth + 1); } catch { /* Plain output stays in tool details. */ }
        }
        return;
      }
      if (Array.isArray(value)) { for (const item of value.slice(0, 40)) visit(item, depth + 1); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (typeof record.url === "string" || typeof record.link === "string") add({ url: record.url ?? record.link, title: record.title ?? record.name, description: record.snippet ?? record.description });
      // Structured envelopes only; traversing arbitrary object properties can turn unrelated app data into sources.
      for (const key of ["results", "sources", "items", "data", "content", "text", "organic_results", "web_results"]) if (record[key] !== undefined) visit(record[key], depth + 1);
    };
    visit(detail.output, 0);
  }
  return sources;
}
