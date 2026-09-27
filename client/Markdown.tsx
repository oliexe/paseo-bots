import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type TextStyle } from "react-native";
import { parseMarkdown, type Block, type Inline, type ListItem } from "../shared/markdown";
import { MONO_FONT, MONO_PROPS, nativeTokens } from "./native";
import { code, codeLine, content, contentLine } from "./typography";

type Colors = PluginTheme["colors"];

// Styles from Paseo's styles/markdown-styles.ts and the assistant rules in
// components/message.tsx. Sizes scale with the user's content and code sizes.

/** markdown-styles.ts contentHeadingSize: content × (tier / base 14). */
function headingSize(tier: number): number {
  return Math.round(content() * (tier / 14));
}

const HEADINGS: Record<number, { tier: number; weight: TextStyle["fontWeight"]; top: number; bottom: number; rule?: boolean; muted?: boolean }> = {
  1: { tier: 26, weight: "bold", top: 24, bottom: 12, rule: true },
  2: { tier: 22, weight: "bold", top: 24, bottom: 12, rule: true },
  3: { tier: 20, weight: "600", top: 16, bottom: 8 },
  4: { tier: 18, weight: "600", top: 16, bottom: 8 },
  5: { tier: 16, weight: "600", top: 12, bottom: 4 },
  6: { tier: 16, weight: "600", top: 12, bottom: 4, muted: true },
};

const compact = () => Platform.OS !== "web";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: { matchMedia?: (query: string) => { matches: boolean } } | undefined;

/** Paseo shows code copy buttons on hover on desktop web, always on touch screens. */
function hoverCapable(): boolean {
  if (compact()) return false;
  try {
    return typeof window !== "undefined" && window?.matchMedia ? window.matchMedia("(hover: hover)").matches : true;
  } catch {
    return true;
  }
}

interface MarkdownProps {
  colors: Colors;
  text: string;
  /** Still streaming: close unfinished inline marks at the end. */
  streaming?: boolean;
  /** Bare URLs become links (chat); plan cards turn this off like Paseo. */
  linkify?: boolean;
}

export const Markdown = memo(function Markdown({ colors, text, streaming = false, linkify = true }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text, { streaming, linkify }), [text, streaming, linkify]);
  return <Blocks colors={colors} blocks={blocks} />;
});

function Blocks({ colors, blocks, tight }: { colors: Colors; blocks: Block[]; tight?: boolean }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} colors={colors} block={block} last={index === blocks.length - 1} next={blocks[index + 1]} tight={tight} />
      ))}
    </>
  );
}

function bodyStyle(colors: Colors): TextStyle {
  return { color: colors.foreground, fontSize: content(), lineHeight: contentLine() };
}

function BlockView({ colors, block, last, next, tight }: { colors: Colors; block: Block; last: boolean; next?: Block; tight?: boolean }) {
  const body = bodyStyle(colors);
  switch (block.kind) {
    case "paragraph":
      return (
        <Text selectable style={[body, { marginBottom: last || tight ? 0 : 12 }]}>
          <Inlines colors={colors} inlines={block.inlines} />
        </Text>
      );
    case "heading": {
      const spec = HEADINGS[block.level] ?? HEADINGS[6]!;
      const size = headingSize(spec.tier);
      return (
        <View
          style={{
            marginTop: spec.top,
            marginBottom: spec.bottom,
            ...(spec.rule ? { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 8 } : {}),
          }}
        >
          <Text
            selectable
            accessibilityRole="header"
            style={{
              color: spec.muted ? colors.foregroundMuted : colors.foreground,
              fontSize: size,
              lineHeight: Math.round(size * 1.3),
              fontWeight: spec.weight,
              ...(spec.muted ? { textTransform: "uppercase", letterSpacing: 0.5 } : {}),
            }}
          >
            <Inlines colors={colors} inlines={block.inlines} />
          </Text>
        </View>
      );
    }
    case "list":
      return <ListView colors={colors} ordered={block.ordered} items={block.items} tight={block.tight} next={next} nested={tight !== undefined} />;
    case "code":
      return <CodeBlock colors={colors} text={block.text} />;
    case "quote":
      return (
        <View
          style={{
            backgroundColor: colors.surface1,
            borderLeftWidth: 4,
            borderLeftColor: colors.surface2,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 0,
            marginVertical: 12,
            borderRadius: 6,
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
          }}
        >
          {block.blocks.map((inner, index) => (
            // Quoted paragraphs keep their bottom margin: the quote has no bottom padding.
            <BlockView key={index} colors={colors} block={inner} last={false} next={block.blocks[index + 1]} />
          ))}
        </View>
      );
    case "table":
      return <TableView colors={colors} block={block} />;
    case "rule":
      return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 10 }} />;
  }
}

/** utils/markdown-list.ts getMarkdownListSpacing. */
function listSpacing(nested: boolean, next: Block | undefined): { marginTop: number; marginBottom: number } {
  if (nested) return { marginTop: 4, marginBottom: 0 };
  if (!next) return { marginTop: 4, marginBottom: 0 };
  return { marginTop: 4, marginBottom: next.kind === "list" ? 8 : 16 };
}

function ListView({ colors, ordered, items, tight, next, nested }: { colors: Colors; ordered: boolean; items: ListItem[]; tight: boolean; next?: Block; nested: boolean }) {
  const marker: TextStyle = {
    color: colors.foregroundMuted,
    marginRight: 4,
    fontSize: content(),
    lineHeight: contentLine(),
    ...(ordered ? { minWidth: 12 } : {}),
  };
  return (
    <View style={{ width: "100%", ...listSpacing(nested, next) }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4, flexShrink: 1 }}>
          <Text style={marker}>{item.marker}</Text>
          <View style={{ flex: 1, flexShrink: 1, minWidth: 0 }}>
            <Blocks colors={colors} blocks={item.blocks} tight={tight} />
          </View>
        </View>
      ))}
    </View>
  );
}

function TableView({ colors, block }: { colors: Colors; block: Extract<Block, { kind: "table" }> }) {
  const align = (index: number): TextStyle["textAlign"] => block.align[index] ?? "left";
  const cell = { padding: 8, borderRightWidth: 1, borderColor: colors.border, flex: 1 } as const;
  const text = { color: colors.foreground, fontSize: content(), lineHeight: contentLine() } as const;
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, marginVertical: 12, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", backgroundColor: colors.surface2, borderBottomWidth: 1, borderColor: colors.border }}>
        {block.header.map((inlines, index) => (
          <View key={index} style={[cell, index === block.header.length - 1 ? { borderRightWidth: 0 } : null]}>
            <Text selectable style={[text, { fontWeight: "600", textAlign: align(index) }]}>
              <Inlines colors={colors} inlines={inlines} />
            </Text>
          </View>
        ))}
      </View>
      {block.rows.map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", borderBottomWidth: rowIndex === block.rows.length - 1 ? 0 : 1, borderColor: colors.border }}>
          {row.map((inlines, index) => (
            <View key={index} style={[cell, index === row.length - 1 ? { borderRightWidth: 0 } : null]}>
              <Text selectable style={[text, { textAlign: align(index) }]}>
                <Inlines colors={colors} inlines={inlines} />
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function Inlines({ colors, inlines }: { colors: Colors; inlines: Inline[] }) {
  return <>{inlines.map((inline, index) => renderInline(colors, inline, index))}</>;
}

function renderInline(colors: Colors, inline: Inline, key: number): ReactNode {
  switch (inline.kind) {
    case "text":
      return inline.text;
    case "break":
      return "\n";
    case "bold":
      return (
        <Text key={key} style={{ fontWeight: "500" }}>
          <Inlines colors={colors} inlines={inline.children} />
        </Text>
      );
    case "italic":
      return (
        <Text key={key} style={{ fontStyle: "italic" }}>
          <Inlines colors={colors} inlines={inline.children} />
        </Text>
      );
    case "strike":
      return (
        <Text key={key} style={{ textDecorationLine: "line-through", color: colors.foregroundMuted }}>
          <Inlines colors={colors} inlines={inline.children} />
        </Text>
      );
    case "code":
      return (
        <Text
          key={key}
          {...MONO_PROPS}
          style={{ fontFamily: MONO_FONT, fontSize: code(), color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 2 }}
        >
          {inline.text}
        </Text>
      );
    case "link":
      return <Link key={key} colors={colors} url={inline.url} inlines={inline.children} />;
    case "image":
      // Paseo loads the image inline; plugins can't fetch workspace files, so web images open as links.
      return <Link key={key} colors={colors} url={inline.url} inlines={[{ kind: "text", text: inline.alt || inline.url }]} />;
  }
}

/** Opens web links; anything else (workspace files, anchors) is copied, since plugins can't open files. */
function Link({ colors, url, inlines }: { colors: Colors; url: string; inlines: Inline[] }) {
  const toast = useToast();
  const onPress = () => {
    if (isWebUrl(url)) {
      void openExternalUrl(url.trim()).catch(() => toast.error("Couldn't open the link."));
      return;
    }
    const target = url.replace(/^file:\/\//i, "");
    void copyText(target)
      .then(() => toast.show("Path copied", { variant: "success" }))
      .catch(() => toast.error("Couldn't copy the path."));
  };
  return (
    <Text accessibilityRole="link" style={{ color: nativeTokens(colors).accentBright, textDecorationLine: "none" }} onPress={onPress}>
      <Inlines colors={colors} inlines={inlines} />
    </Text>
  );
}

function CodeBlock({ colors, text }: { colors: Colors; text: string }) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const visible = hovered || !hoverCapable();
  const copy = () => {
    const value = text.replace(/\n+$/, "");
    if (!value) return;
    void copyText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  // On web a Pressable tracks hover (the code stays selectable); phones always show the button.
  const Container = Platform.OS === "web" ? Pressable : View;
  return (
    <Container
      {...(Platform.OS === "web" ? { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) } : {})}
      style={{ position: "relative", backgroundColor: colors.surface2, padding: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.border, marginVertical: 12, cursor: "auto" } as object}
    >
      <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Copied" : "Copy code"}
        onPress={copy}
        onHoverIn={() => setButtonHovered(true)}
        onHoverOut={() => setButtonHovered(false)}
        hitSlop={8}
        pointerEvents={visible ? "auto" : "none"}
        style={{ position: "absolute", top: 8, right: 8, padding: 4, opacity: visible ? 1 : 0 }}
      >
        <Icon name={copied ? "Check" : "Copy"} size={14} color={buttonHovered ? colors.foreground : colors.foregroundMuted} />
      </Pressable>
    </Container>
  );
}
