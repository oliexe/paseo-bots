import { splitTimelineMessage } from "paseo-plugin-genui/shared/segment";

export function assistantGenUiItems(text: string, phase: "streaming" | "complete", messageId?: string) {
  return splitTimelineMessage(text, phase, messageId)?.items ?? null;
}
