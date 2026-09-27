export type SkillSource =
  | { kind: "raw"; url: string }
  | { kind: "github"; owner: string; repo: string; ref: string | null; path: string };

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

/** Accepts "owner/repo", "owner/repo/path", github.com URLs (repo, tree, blob) and raw SKILL.md URLs. */
export function parseSkillSource(input: string): SkillSource {
  const source = input.trim();
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.hostname === "github.com") {
      const [owner, repo, mode, ref, ...rest] = trimSlashes(url.pathname).split("/");
      if (!owner || !repo) throw new Error("That GitHub URL doesn't name a repository.");
      if (mode === "blob" || mode === "tree") {
        let path = rest.join("/");
        if (mode === "blob") path = path.replace(/\/?SKILL\.md$/i, "");
        return { kind: "github", owner, repo: repo.replace(/\.git$/, ""), ref: ref ?? null, path };
      }
      return { kind: "github", owner, repo: repo.replace(/\.git$/, ""), ref: null, path: "" };
    }
    if (/SKILL\.md$/i.test(url.pathname)) return { kind: "raw", url: source };
    throw new Error("Use a GitHub repository, a GitHub folder, or a link to a SKILL.md file.");
  }
  const parts = trimSlashes(source).split("/");
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('Use "owner/repo", "owner/repo/path/to/skill" or a GitHub URL.');
  }
  const [owner, repo, ...rest] = parts;
  return { kind: "github", owner: owner!, repo: repo!, ref: null, path: rest.join("/").replace(/\/?SKILL\.md$/i, "") };
}

/** Reads `name` and `description` from SKILL.md frontmatter. */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const read = (key: string) => {
    const line = match?.[1]?.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}:`));
    const value = line?.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
    return value ? value : null;
  };
  return { name: read("name"), description: read("description") };
}

export function sanitizeSkillName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "skill";
}
