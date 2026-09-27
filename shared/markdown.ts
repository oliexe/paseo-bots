// Markdown for chat replies. The plugin SDK has no markdown component, so this
// is a small CommonMark + GFM parser shaped after what Paseo's markdown-it setup
// renders (utils/assistant-markdown-parser.ts): html off, linkify on, tables and
// strikethrough on, soft line breaks kept as line breaks (message.tsx softbreak).

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "image"; url: string; alt: string }
  | { kind: "break" };

export interface ListItem {
  marker: string;
  blocks: Block[];
}

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

export interface ParseOptions {
  /** The text is still streaming: complete unclosed inline marks at its end, like Paseo's streaming parser. */
  streaming?: boolean;
  /** Turn bare URLs into links (on for chat, off for plan cards, as in Paseo). Default true. */
  linkify?: boolean;
}

/** Link reference definitions, plus whether bare URLs become links. */
type References = Map<string, string> & { linkify?: boolean };

// ---------------------------------------------------------------- inline

const PUNCTUATION = /[!-/:-@[-`{-~ -⁯⸀-⹿　-〿]/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–" };

interface Delim {
  kind: "delim";
  char: "*" | "_" | "~";
  count: number;
  original: number;
  canOpen: boolean;
  canClose: boolean;
}

interface Bracket {
  kind: "bracket";
  image: boolean;
  /** Source index just after the opening "[". */
  start: number;
  active: boolean;
}

type Token = Inline | Delim | Bracket;

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isPunct = (char: string | undefined) => char !== undefined && PUNCTUATION.test(char);

function pushText(tokens: Token[], text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last?.kind === "text") last.text += text;
  else tokens.push({ kind: "text", text });
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Link destination and optional title after "](" ... ")". Returns the url and the index after ")". */
function parseLinkTail(src: string, start: number): { url: string; end: number } | null {
  let i = start;
  while (i < src.length && /[ \t\n]/.test(src[i]!)) i++;
  let url = "";
  if (src[i] === "<") {
    const close = src.indexOf(">", i + 1);
    if (close < 0 || src.slice(i + 1, close).includes("\n")) return null;
    url = src.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const begin = i;
    while (i < src.length) {
      const char = src[i]!;
      if (char === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
        i += 2;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === "(") depth++;
      if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    url = src.slice(begin, i).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (i < src.length && /[ \t\n]/.test(src[i]!)) i++;
  const quote = src[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closing = quote === "(" ? ")" : quote;
    const close = src.indexOf(closing, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (i < src.length && /[ \t\n]/.test(src[i]!)) i++;
  }
  if (src[i] !== ")") return null;
  return { url, end: i + 1 };
}

function plainText(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
        case "code":
          return inline.text;
        case "break":
          return "\n";
        case "image":
          return inline.alt;
        default:
          return plainText(inline.children);
      }
    })
    .join("");
}

/** CommonMark's "process emphasis" over a token run; leftover delimiters become text. */
function processEmphasis(tokens: Token[], streaming: boolean): Inline[] {
  let i = 0;
  while (i < tokens.length) {
    const closer = tokens[i]!;
    if (closer.kind !== "delim" || !closer.canClose || closer.count === 0) {
      i++;
      continue;
    }
    let found = -1;
    for (let j = i - 1; j >= 0; j--) {
      const opener = tokens[j]!;
      if (opener.kind !== "delim" || opener.char !== closer.char || !opener.canOpen || opener.count === 0) continue;
      if (closer.char === "~") {
        if (opener.count === 2 && closer.count === 2) found = j;
        if (found >= 0) break;
        continue;
      }
      const oddMatch =
        (opener.canClose || closer.canOpen) && (opener.original + closer.original) % 3 === 0 && !(opener.original % 3 === 0 && closer.original % 3 === 0);
      if (oddMatch) continue;
      found = j;
      break;
    }
    if (found < 0) {
      i++;
      continue;
    }
    const opener = tokens[found] as Delim;
    const use = closer.char === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const kind = closer.char === "~" ? "strike" : use === 2 ? "bold" : "italic";
    const node: Inline = { kind, children: finish(tokens.slice(found + 1, i)) };
    opener.count -= use;
    closer.count -= use;
    const replacement: Token[] = [];
    if (opener.count > 0) replacement.push(opener);
    replacement.push(node);
    if (closer.count > 0) replacement.push(closer);
    tokens.splice(found, i - found + 1, ...replacement);
    i = found + replacement.length - (closer.count > 0 ? 1 : 0);
  }

  if (streaming) {
    // Paseo's streaming parser closes emphasis the model hasn't closed yet.
    for (let j = tokens.length - 1; j >= 0; j--) {
      const opener = tokens[j]!;
      if (opener.kind !== "delim" || !opener.canOpen || opener.count === 0) continue;
      if (opener.char === "~" && opener.count !== 2) continue;
      const rest = tokens.slice(j + 1);
      if (!rest.some((token) => token.kind !== "text" || token.text.trim())) continue;
      const use = opener.char === "~" ? 2 : Math.min(2, opener.count);
      const kind = opener.char === "~" ? "strike" : use === 2 ? "bold" : "italic";
      opener.count -= use;
      tokens.splice(j + 1, rest.length, { kind, children: finish(rest) });
      if (opener.count === 0) tokens.splice(j, 1);
    }
  }
  return finish(tokens);
}

function finish(tokens: Token[]): Inline[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "delim") pushText(out, token.char.repeat(token.count));
    else if (token.kind === "bracket") pushText(out, token.image ? "![" : "[");
    else if (token.kind === "text") pushText(out, token.text);
    else out.push(token);
  }
  return out as Inline[];
}

const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/g;

/** markdown-it's linkify for http(s) and www. links in plain text. */
function linkify(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.kind === "text") {
      let last = 0;
      BARE_URL.lastIndex = 0;
      for (let match = BARE_URL.exec(inline.text); match; match = BARE_URL.exec(inline.text)) {
        const before = inline.text[match.index - 1];
        if (before && /[\w@/]/.test(before)) continue;
        let url = match[0];
        // Keep balanced parentheses, drop a trailing unmatched one.
        while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
        if (match.index > last) out.push({ kind: "text", text: inline.text.slice(last, match.index) });
        out.push({ kind: "link", url: url.startsWith("www.") ? `http://${url}` : url, children: [{ kind: "text", text: url }] });
        last = match.index + url.length;
        BARE_URL.lastIndex = last;
      }
      if (last < inline.text.length) out.push({ kind: "text", text: inline.text.slice(last) });
    } else if (inline.kind === "bold" || inline.kind === "italic" || inline.kind === "strike") {
      out.push({ ...inline, children: linkify(inline.children) });
    } else out.push(inline);
  }
  return out;
}

export function parseInline(source: string, options: ParseOptions = {}, references: References = new Map()): Inline[] {
  const src = source;
  const streaming = options.streaming === true;
  const tokens: Token[] = [];
  let i = 0;
  let text = "";
  const flushText = () => {
    pushText(tokens, text);
    text = "";
  };

  while (i < src.length) {
    const char = src[i]!;

    if (char === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        flushText();
        tokens.push({ kind: "break" });
        i += 2;
        while (src[i] === " " || src[i] === "\t") i++;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        text += next;
        i += 2;
        continue;
      }
      text += char;
      i++;
      continue;
    }

    if (char === "\n") {
      text = text.replace(/[ \t]+$/, "");
      flushText();
      const last = tokens[tokens.length - 1];
      if (last?.kind === "text") last.text = last.text.replace(/[ \t]+$/, "");
      tokens.push({ kind: "break" });
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }

    if (char === "`") {
      let run = 0;
      while (src[i + run] === "`") run++;
      const fence = "`".repeat(run);
      let search = i + run;
      let close = -1;
      while (search < src.length) {
        const at = src.indexOf(fence, search);
        if (at < 0) break;
        let length = 0;
        while (src[at + length] === "`") length++;
        if (length === run) {
          close = at;
          break;
        }
        search = at + length;
      }
      if (close >= 0) {
        let body = src.slice(i + run, close).replace(/\n/g, " ");
        if (body.length > 1 && body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
        flushText();
        tokens.push({ kind: "code", text: body });
        i = close + run;
        continue;
      }
      if (streaming) {
        // Unclosed code at the streaming tail renders as code (streaming-markdown completeCode).
        let body = src.slice(i + run);
        body = body.replace(/`+$/, "");
        flushText();
        if (body) tokens.push({ kind: "code", text: body.replace(/\n/g, " ") });
        i = src.length;
        continue;
      }
      text += fence;
      i += run;
      continue;
    }

    if (char === "*" || char === "_" || char === "~") {
      let run = 0;
      while (src[i + run] === char) run++;
      const before = i === 0 ? undefined : src[i - 1];
      const after = src[i + run];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      let canOpen = left;
      let canClose = right;
      if (char === "_") {
        canOpen = left && (!right || isPunct(before));
        canClose = right && (!left || isPunct(after));
      }
      if (char === "~" && run !== 2) {
        text += char.repeat(run);
        i += run;
        continue;
      }
      // A lone opening marker at the streaming tail is hidden until its text arrives.
      if (streaming && i + run === src.length && !canClose) {
        i += run;
        continue;
      }
      flushText();
      tokens.push({ kind: "delim", char, count: run, original: run, canOpen, canClose });
      i += run;
      continue;
    }

    if (char === "!" && src[i + 1] === "[") {
      flushText();
      tokens.push({ kind: "bracket", image: true, start: i + 2, active: true });
      i += 2;
      continue;
    }

    if (char === "[") {
      flushText();
      tokens.push({ kind: "bracket", image: false, start: i + 1, active: true });
      i++;
      continue;
    }

    if (char === "]") {
      flushText();
      let openerIndex = -1;
      for (let j = tokens.length - 1; j >= 0; j--) {
        const token = tokens[j]!;
        if (token.kind === "bracket") {
          openerIndex = j;
          break;
        }
      }
      if (openerIndex < 0) {
        pushText(tokens, "]");
        i++;
        continue;
      }
      const opener = tokens[openerIndex] as Bracket;
      if (!opener.active) {
        tokens.splice(openerIndex, 1, { kind: "text", text: opener.image ? "![" : "[" });
        pushText(tokens, "]");
        i++;
        continue;
      }
      const label = src.slice(opener.start, i);
      let url: string | null = null;
      let end = i + 1;
      if (src[i + 1] === "(") {
        const tail = parseLinkTail(src, i + 2);
        if (tail) {
          url = tail.url;
          end = tail.end;
        }
      }
      if (url === null) {
        const reference = /^\[([^\]]*)\]/.exec(src.slice(i + 1));
        if (reference) {
          const key = normalizeLabel(reference[1] || label);
          if (references.has(key)) {
            url = references.get(key)!;
            end = i + 1 + reference[0].length;
          }
        } else if (references.has(normalizeLabel(label))) {
          url = references.get(normalizeLabel(label))!;
        }
      }
      if (url === null) {
        if (streaming && /^\((?:[^)\s]*)$/.test(src.slice(i + 1))) {
          // A link still streaming its destination shows its text only.
          const children = processEmphasis(tokens.slice(openerIndex + 1), false);
          tokens.splice(openerIndex, tokens.length - openerIndex, ...children);
          i = src.length;
          continue;
        }
        tokens.splice(openerIndex, 1, { kind: "text", text: opener.image ? "![" : "[" });
        pushText(tokens, "]");
        i++;
        continue;
      }
      const children = processEmphasis(tokens.slice(openerIndex + 1), false);
      const node: Inline = opener.image ? { kind: "image", url, alt: plainText(children) } : { kind: "link", url, children };
      tokens.splice(openerIndex, tokens.length - openerIndex, node);
      if (!opener.image) {
        for (const token of tokens) if (token.kind === "bracket" && !token.image) token.active = false;
      }
      i = end;
      continue;
    }

    if (char === "<") {
      const auto = AUTOLINK.exec(src.slice(i));
      if (auto) {
        flushText();
        tokens.push({ kind: "link", url: auto[1]!, children: [{ kind: "text", text: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
      const email = EMAIL_AUTOLINK.exec(src.slice(i));
      if (email) {
        flushText();
        tokens.push({ kind: "link", url: `mailto:${email[1]}`, children: [{ kind: "text", text: email[1]! }] });
        i += email[0].length;
        continue;
      }
    }

    if (char === "&") {
      const entity = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/.exec(src.slice(i));
      if (entity) {
        const code = entity[1] ? Number(entity[1]) : entity[2] ? parseInt(entity[2], 16) : NaN;
        const named = entity[3] ? ENTITIES[entity[3]] : undefined;
        if (Number.isFinite(code) || named !== undefined) {
          text += named ?? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�");
          i += entity[0].length;
          continue;
        }
      }
    }

    text += char;
    i++;
  }
  flushText();
  const inlines = processEmphasis(tokens, streaming);
  return references.linkify === false || options.linkify === false ? inlines : linkify(inlines);
}

// ---------------------------------------------------------------- blocks

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const REFERENCE = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Removes `width` columns of leading indentation. */
function stripIndent(line: string, width: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width) {
    const char = line[index]!;
    if (char === " ") removed++;
    else if (char === "\t") removed += 4 - (removed % 4);
    else break;
    index++;
  }
  return line.slice(index);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = 0;
  for (let i = 0; i < row.length; i++) {
    const char = row[i]!;
    if (char === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (char === "`") {
      let run = 0;
      while (row[i + run] === "`") run++;
      inCode = inCode === run ? 0 : inCode === 0 ? run : inCode;
      current += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (char === "|" && inCode === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (header === undefined || delimiter === undefined || !header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
  if (indentOf(header) >= 4) return false;
  return splitRow(header).length === splitRow(delimiter).length;
}

/** Whether a line starts a block that ends (interrupts) a paragraph. */
function interruptsParagraph(line: string): boolean {
  if (FENCE_OPEN.test(line) || ATX.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  if (item && item[4] !== undefined && item[4].trim()) {
    return !/\d/.test(item[2]!) || /^1[.)]$/.test(item[2]!);
  }
  return false;
}

function collectReferences(lines: string[], references: References): void {
  let fence: string | null = null;
  for (const line of lines) {
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    if (open && !(open[2]![0] === "`" && open[3]!.includes("`"))) {
      fence = open[2]!;
      continue;
    }
    const reference = REFERENCE.exec(line);
    if (reference) {
      const key = normalizeLabel(reference[1]!);
      if (!references.has(key)) references.set(key, reference[2]!);
    }
  }
}

function parseBlocks(lines: string[], tail: boolean, references: References): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flush = (streaming = false) => {
    if (paragraph.length === 0) return;
    const content = paragraph.join("\n").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    paragraph = [];
    if (content) blocks.push({ kind: "paragraph", inlines: parseInline(content, { streaming }, references) });
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // Indented code can't interrupt a paragraph.
    if (paragraph.length === 0 && indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]!) >= 4 || !lines[i]!.trim())) body.push(stripIndent(lines[i++]!, 4));
      while (body.length > 0 && !body[body.length - 1]!.trim()) body.pop();
      blocks.push({ kind: "code", language: "", text: body.join("\n") });
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      flush();
      const marker = fence[2]!;
      const indent = fence[1]!.length;
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(stripIndent(lines[i++]!, indent));
      i++;
      blocks.push({ kind: "code", language: fence[3]!.trim().split(/\s+/)[0] ?? "", text: body.join("\n") });
      continue;
    }

    if (paragraph.length > 0) {
      const setext = SETEXT.exec(line);
      if (setext) {
        const content = paragraph.join("\n").trim();
        paragraph = [];
        blocks.push({ kind: "heading", level: setext[1]![0] === "=" ? 1 : 2, inlines: parseInline(content, {}, references) });
        i++;
        continue;
      }
    }

    const atx = ATX.exec(line);
    if (atx) {
      flush();
      const content = atx[2]!.replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "").trim();
      blocks.push({ kind: "heading", level: atx[1]!.length, inlines: parseInline(content, {}, references) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      let lazy = false;
      while (i < lines.length) {
        const current = lines[i]!;
        const quoted = QUOTE.exec(current);
        if (quoted) {
          inner.push(quoted[1]!);
          lazy = quoted[1]!.trim().length > 0 && !FENCE_OPEN.test(quoted[1]!);
          i++;
          continue;
        }
        // Lazy continuation of a quoted paragraph.
        if (lazy && current.trim() && !interruptsParagraph(current)) {
          inner.push(current);
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner, tail && i >= lines.length, references) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item && (paragraph.length === 0 || interruptsParagraph(line))) {
      flush();
      const list = parseList(lines, i, tail, references);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    if (isTableStart(lines, i)) {
      flush();
      const header = splitRow(lines[i]!);
      const align = splitRow(lines[i + 1]!).map((cell): TableAlign => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|") && !interruptsParagraph(lines[i]!)) {
        const cells = splitRow(lines[i]!);
        rows.push(header.map((_, column) => parseInline(cells[column] ?? "", {}, references)));
        i++;
      }
      blocks.push({ kind: "table", align, header: header.map((cell) => parseInline(cell, {}, references)), rows });
      continue;
    }

    if (paragraph.length === 0 && REFERENCE.test(line)) {
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flush(tail);
  return blocks;
}

function parseList(lines: string[], start: number, tail: boolean, references: References): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const delimiter = ordered ? first[2]!.slice(-1) : first[2]!;
  const startNumber = ordered ? parseInt(first[2]!, 10) : 1;
  const items: { lines: string[] }[] = [];
  let tight = true;
  let i = start;
  let sawBlank = false;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!);
    if (!match) break;
    const sameKind = ordered ? /\d/.test(match[2]!) && match[2]!.slice(-1) === delimiter : match[2] === delimiter;
    if (!sameKind || RULE.test(lines[i]!)) break;
    if (sawBlank && items.length > 0) tight = false;
    sawBlank = false;
    const markerWidth = match[1]!.length + match[2]!.length;
    const spacing = match[3] ? indentOf(match[3]) : 1;
    const contentStart = match[4] === undefined || !match[4].trim() ? 1 : spacing > 4 ? 1 : spacing;
    const width = markerWidth + contentStart;
    const firstLine = match[4] === undefined ? "" : spacing > 4 ? " ".repeat(spacing - 1) + match[4] : match[4];
    const body: string[] = [firstLine];
    i++;
    let blankInside = false;
    while (i < lines.length) {
      const current = lines[i]!;
      if (!current.trim()) {
        body.push("");
        blankInside = true;
        i++;
        continue;
      }
      if (indentOf(current) >= width) {
        if (blankInside && body.some((entry) => entry.trim())) tight = false;
        blankInside = false;
        body.push(stripIndent(current, width));
        i++;
        continue;
      }
      // Lazy paragraph continuation.
      if (!blankInside && !interruptsParagraph(current) && !LIST_ITEM.test(current) && !isTableStart(lines, i)) {
        body.push(current.trimStart());
        i++;
        continue;
      }
      break;
    }
    // Trailing blank lines belong between items, not inside this one.
    let trailing = 0;
    while (body.length > 1 && !body[body.length - 1]!.trim()) {
      body.pop();
      trailing++;
    }
    if (trailing > 0) sawBlank = true;
    items.push({ lines: body });
    if (trailing > 0 && (i >= lines.length || !LIST_ITEM.test(lines[i]!))) break;
  }

  const atEnd = tail && lines.slice(i).every((line) => !line.trim());
  const parsed: ListItem[] = items.map((entry, index) => {
    const blocks = parseBlocks(entry.lines, atEnd && index === items.length - 1, references);
    return { marker: ordered ? `${startNumber + index}${delimiter}` : "•", blocks };
  });
  return { block: { kind: "list", ordered, start: startNumber, tight, items: parsed }, next: i };
}

export function parseMarkdown(source: string, options: ParseOptions = {}): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const references: References = Object.assign(new Map<string, string>(), { linkify: options.linkify !== false });
  collectReferences(lines, references);
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  return parseBlocks(lines, options.streaming === true, references);
}

/** Plain text of inlines, for accessibility labels and copy. */
export function inlineText(inlines: Inline[]): string {
  return plainText(inlines);
}

// ---------------------------------------------------------------- limits

/** Paseo caps what it renders of one assistant message (assistant-message-render-limit.ts). */
export const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export function capMessageForRender(message: string): { text: string; capped: boolean } {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) return { text: message, capped: false };
  let end = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  const code = message.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: message.slice(0, end), capped: true };
}

export function utf8ByteLength(message: string): number {
  let bytes = 0;
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < message.length) {
      const next = message.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// ---------------------------------------------------------------- time

/**
 * Paseo's duration format (utils/time.ts formatDuration): whole seconds under a
 * minute, then "2m 12s" / "2m", then "1h 5m" / "1h". Always floors.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function calendarDaysBetween(earlier: Date, later: Date): number {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / 86_400_000);
}

let timeFormatter: Intl.DateTimeFormat | null = null;

/**
 * Paseo's hover timestamp (utils/time.ts formatMessageTimestamp): the time today,
 * "Wednesday 10:11 PM" within the week, "14 May 2026, 10:11 PM" before that.
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  if (!timeFormatter) {
    const resolved = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).resolvedOptions();
    timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hourCycle: resolved.hourCycle });
  }
  const time = timeFormatter.format(date);
  const daysAgo = calendarDaysBetween(date, now);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${time}`;
}
