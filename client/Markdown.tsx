import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown as PaseoMarkdown } from "@getpaseo/plugin/client/ui";
import { memo } from "react";

interface MarkdownProps {
  colors: PluginTheme["colors"];
  text: string;
  streaming?: boolean;
  linkify?: boolean;
}

/** Keep callers compatible while Paseo owns typography, selection, code and links. */
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return <PaseoMarkdown>{text}</PaseoMarkdown>;
});
