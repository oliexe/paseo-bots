import { describe, expect, it } from "vitest";
import { capMessageForRender, formatDuration, parseInline, parseMarkdown, utf8ByteLength, type Block, type Inline } from "../shared/markdown";

const text = (value: string): Inline => ({ kind: "text", text: value });

describe("parseMarkdown blocks", () => {
  it("splits paragraphs, lists, headings and fences", () => {
    const blocks = parseMarkdown("# Title\n\nHello **world** and `code`.\n\n1. one\n2. two\n\n- a\n\n```ts\nconst x = 1;\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list", "code"]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      inlines: [text("Hello "), { kind: "bold", children: [text("world")] }, text(" and "), { kind: "code", text: "code" }, text(".")],
    });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 1, items: [{ marker: "1." }, { marker: "2." }] });
    expect(blocks[4]).toEqual({ kind: "code", language: "ts", text: "const x = 1;" });
  });

  it("keeps single newlines as line breaks", () => {
    expect(parseMarkdown("one\ntwo")).toEqual([{ kind: "paragraph", inlines: [text("one"), { kind: "break" }, text("two")] }]);
  });

  it("keeps an unterminated fence while streaming", () => {
    expect(parseMarkdown("```\npartial")).toEqual([{ kind: "code", language: "", text: "partial" }]);
  });

  it("parses tilde fences and indented code", () => {
    expect(parseMarkdown("~~~py\nprint(1)\n~~~")).toEqual([{ kind: "code", language: "py", text: "print(1)" }]);
    expect(parseMarkdown("    let x;\n    x = 1;")).toEqual([{ kind: "code", language: "", text: "let x;\nx = 1;" }]);
  });

  it("parses setext headings and keeps thematic breaks", () => {
    const blocks = parseMarkdown("Title\n=====\n\nSub\n---\n\n***");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inlines: [text("Title")] },
      { kind: "heading", level: 2, inlines: [text("Sub")] },
      { kind: "rule" },
    ]);
  });

  it("strips closing hashes from ATX headings", () => {
    expect(parseMarkdown("## Hello ##")).toEqual([{ kind: "heading", level: 2, inlines: [text("Hello")] }]);
    expect(parseMarkdown("#hashtag")[0]!.kind).toBe("paragraph");
  });

  it("parses a multi-line blockquote as one block", () => {
    const [quote] = parseMarkdown("> first\n> second\nlazy\n>\n> - item");
    expect(quote).toMatchObject({ kind: "quote" });
    const inner = (quote as Extract<Block, { kind: "quote" }>).blocks;
    expect(inner.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(inner[0]).toEqual({ kind: "paragraph", inlines: [text("first"), { kind: "break" }, text("second"), { kind: "break" }, text("lazy")] });
  });

  it("parses nested lists and ordered starts", () => {
    const [list] = parseMarkdown("3. three\n   - nested\n   - more\n4. four");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3, tight: true });
    const items = (list as Extract<Block, { kind: "list" }>).items;
    expect(items.map((item) => item.marker)).toEqual(["3.", "4."]);
    expect(items[0]!.blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(items[0]!.blocks[1]).toMatchObject({ kind: "list", ordered: false, items: [{ marker: "•" }, { marker: "•" }] });
  });

  it("marks lists with blank lines between items as loose", () => {
    expect(parseMarkdown("- a\n\n- b")[0]).toMatchObject({ kind: "list", tight: false });
    expect(parseMarkdown("- a\n- b")[0]).toMatchObject({ kind: "list", tight: true });
  });

  it("doesn't start an ordered list mid-paragraph unless it starts at 1", () => {
    expect(parseMarkdown("The year was\n2019. It rained.").map((block) => block.kind)).toEqual(["paragraph"]);
    expect(parseMarkdown("Steps:\n1. go").map((block) => block.kind)).toEqual(["paragraph", "list"]);
  });

  it("parses GFM tables with alignment", () => {
    const [table] = parseMarkdown("| Name | Size |\n| :--- | ---: |\n| a | `1|2` |\n| b | 3 |");
    expect(table).toMatchObject({ kind: "table", align: ["left", "right"] });
    const block = table as Extract<Block, { kind: "table" }>;
    expect(block.header).toEqual([[text("Name")], [text("Size")]]);
    expect(block.rows).toHaveLength(2);
    expect(block.rows[0]![1]).toEqual([{ kind: "code", text: "1|2" }]);
  });

  it("resolves reference links", () => {
    const [paragraph] = parseMarkdown("See [the docs][docs].\n\n[docs]: https://paseo.sh");
    expect(paragraph).toEqual({
      kind: "paragraph",
      inlines: [text("See "), { kind: "link", url: "https://paseo.sh", children: [text("the docs")] }, text(".")],
    });
  });
});

describe("parseInline", () => {
  it("parses links and italics", () => {
    expect(parseInline("see [docs](https://paseo.sh) *now*")).toEqual([
      text("see "),
      { kind: "link", url: "https://paseo.sh", children: [text("docs")] },
      text(" "),
      { kind: "italic", children: [text("now")] },
    ]);
  });

  it("doesn't italicise snake_case", () => {
    expect(parseInline("call snake_case_name here")).toEqual([text("call snake_case_name here")]);
    expect(parseInline("_real_")).toEqual([{ kind: "italic", children: [text("real")] }]);
  });

  it("nests emphasis", () => {
    expect(parseInline("***both***")).toEqual([{ kind: "italic", children: [{ kind: "bold", children: [text("both")] }] }]);
    expect(parseInline("**bold *and italic***")).toEqual([{ kind: "bold", children: [text("bold "), { kind: "italic", children: [text("and italic")] }] }]);
  });

  it("parses strikethrough", () => {
    expect(parseInline("~~gone~~ ~one~")).toEqual([{ kind: "strike", children: [text("gone")] }, text(" ~one~")]);
  });

  it("honours backslash escapes and entities", () => {
    expect(parseInline("\\*not em\\* &amp; &#65;")).toEqual([text("*not em* & A")]);
  });

  it("parses autolinks and bare URLs", () => {
    expect(parseInline("<https://a.b/c>")).toEqual([{ kind: "link", url: "https://a.b/c", children: [text("https://a.b/c")] }]);
    expect(parseInline("go to https://paseo.sh/docs.")).toEqual([
      text("go to "),
      { kind: "link", url: "https://paseo.sh/docs", children: [text("https://paseo.sh/docs")] },
      text("."),
    ]);
    expect(parseInline("go to https://paseo.sh", { linkify: false })).toEqual([text("go to https://paseo.sh")]);
  });

  it("keeps code spans literal", () => {
    expect(parseInline("``a `b` c`` and `*x*`")).toEqual([{ kind: "code", text: "a `b` c" }, text(" and "), { kind: "code", text: "*x*" }]);
    expect(parseInline("`unclosed")).toEqual([text("`unclosed")]);
  });

  it("completes unclosed marks while streaming", () => {
    expect(parseInline("a **bol", { streaming: true })).toEqual([text("a "), { kind: "bold", children: [text("bol")] }]);
    expect(parseInline("run `npm i", { streaming: true })).toEqual([text("run "), { kind: "code", text: "npm i" }]);
    expect(parseInline("wait *", { streaming: true })).toEqual([text("wait ")]);
    expect(parseInline("see [docs](https://pas", { streaming: true })).toEqual([text("see docs")]);
  });

  it("parses images", () => {
    expect(parseInline("![alt text](https://x/y.png)")).toEqual([{ kind: "image", url: "https://x/y.png", alt: "alt text" }]);
  });
});

describe("render limits", () => {
  it("caps long messages", () => {
    const long = "a".repeat(40_000);
    expect(capMessageForRender(long)).toEqual({ text: "a".repeat(32_000), capped: true });
    expect(capMessageForRender("short")).toEqual({ text: "short", capped: false });
    expect(utf8ByteLength("aé€😀")).toBe(1 + 2 + 3 + 4);
  });
});

describe("formatDuration", () => {
  it("floors like Paseo", () => {
    expect(formatDuration(400)).toBe("0s");
    expect(formatDuration(24_900)).toBe("24s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(-1)).toBe("0s");
  });
});
