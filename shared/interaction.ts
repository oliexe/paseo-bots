import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { botToolName } from "./bot-tools";

// The native timeline accepts at most 64 KiB of plugin data. Reserve room for
// both the original card and its final edited answer, plus ids/error metadata.
export const INTERACTION_PART_BYTES = 28 * 1024;
export const INTERACTION_DATA_BYTES = 64 * 1024;

/** Count encoded JSON bytes without relying on Buffer or a browser TextEncoder. */
export function jsonUtf8Bytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const Key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "Choose a different field id");
const Label = z.string().trim().min(1).max(160);
const Option = z.object({ id: Key, label: Label, description: z.string().max(500).optional() }).strict();
const FieldBase = { id: Key, label: Label, required: z.boolean().default(false) };

export const InteractionFieldSchema = z.discriminatedUnion("kind", [
  z.object({ ...FieldBase, kind: z.enum(["text", "textarea"]), value: z.string().max(8000).default(""), placeholder: z.string().max(200).optional() }).strict(),
  z.object({ ...FieldBase, kind: z.literal("select"), options: z.array(Label).min(1).max(20), value: z.string().max(160).default("") }).strict(),
  z.object({ ...FieldBase, kind: z.literal("date"), value: z.string().max(10).default("") }).strict(),
]);
export type InteractionField = z.infer<typeof InteractionFieldSchema>;

const Common = { title: Label, description: z.string().max(2000).default("") };
export const InteractionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ ...Common, kind: z.literal("confirm"), preview: z.string().max(30_000).default(""), actions: z.array(z.object({ id: Key, label: Label, primary: z.boolean().default(false) }).strict()).min(1).max(4) }).strict(),
  z.object({ ...Common, kind: z.literal("choice"), options: z.array(Option).min(1).max(20), multiple: z.boolean().default(false), submitLabel: Label.default("Send choice") }).strict(),
  z.object({ ...Common, kind: z.literal("form"), fields: z.array(InteractionFieldSchema).min(1).max(12), submitLabel: Label.default("Send answers") }).strict(),
  z.object({ ...Common, kind: z.literal("draft"), text: z.string().min(1).max(50_000), fields: z.array(InteractionFieldSchema).max(8).default([]), submitLabel: Label.default("Approve draft") }).strict(),
]).superRefine((spec, context) => {
  if (jsonUtf8Bytes(spec) > INTERACTION_PART_BYTES) context.addIssue({ code: "custom", message: "This card is too large for chat. Shorten its draft, preview or fields, or split it into smaller cards." });
  const unique = (ids: string[], path: string) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [path], message: "Each id must be unique" });
  };
  if (spec.kind === "confirm") {
    unique(spec.actions.map((action) => action.id), "actions");
    if (spec.actions.some((action) => action.id === "dismiss")) context.addIssue({ code: "custom", path: ["actions"], message: 'The action id "dismiss" is reserved' });
  }
  if (spec.kind === "choice") unique(spec.options.map((option) => option.id), "options");
  if (spec.kind === "form" || spec.kind === "draft") {
    unique(spec.fields.map((field) => field.id), "fields");
    spec.fields.forEach((field, index) => {
      if (field.kind === "select" && (new Set(field.options).size !== field.options.length || (field.value && !field.options.includes(field.value)))) {
        context.addIssue({ code: "custom", path: ["fields", index], message: "Choices must be unique and the initial value must be one of them" });
      }
      if (field.kind === "date" && field.value && !isCalendarDate(field.value)) context.addIssue({ code: "custom", path: ["fields", index], message: "Use a real date in YYYY-MM-DD format" });
    });
  }
});
export type InteractionSpec = z.infer<typeof InteractionSpecSchema>;

export const InteractionResponseSchema = z.object({
  action: Key,
  values: z.record(Key, z.string().max(8000)).default({}),
  selected: z.array(Key).max(20).default([]),
  text: z.string().max(50_000).default(""),
}).strict().refine((value) => Object.keys(value.values).length <= 12, "Too many fields")
  .refine((value) => jsonUtf8Bytes(value) <= INTERACTION_PART_BYTES, "This answer is too large for chat. Shorten the draft or field values before sending.");
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

export const InteractionIdSchema = z.string().regex(/^i-[a-f0-9]{24}$/);
export const InteractionSchema = z.object({
  id: InteractionIdSchema,
  botId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  spec: InteractionSpecSchema,
  status: z.enum(["pending", "submitting", "answered", "dismissed"]),
  response: InteractionResponseSchema.nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  error: z.string().max(1000).nullable(),
}).refine((value) => jsonUtf8Bytes(value) <= INTERACTION_DATA_BYTES, "This card exceeds the chat's storage limit.");
export type Interaction = z.infer<typeof InteractionSchema>;
export const INTERACTION_CARD = { kind: "interaction", version: 1 } as const;

const Address = { id: InteractionIdSchema, agentId: z.string().min(1).max(200) };
export const interactionGetRpc = defineRpc({ name: "bots.interactions.get", input: z.object({ ...Address, restore: z.boolean().optional() }), output: z.object({ interaction: InteractionSchema.nullable() }) });
export const interactionRestoreRpc = defineRpc({ name: "bots.interactions.restore", input: z.object({ agentId: Address.agentId }), output: z.object({ restored: z.number().int().nonnegative() }) });
export const interactionRespondRpc = defineRpc({ name: "bots.interactions.respond", input: z.object({ ...Address, response: InteractionResponseSchema.optional() }), output: z.object({ interaction: InteractionSchema }) });

/** Recover only our completed tool's structured receipt, never a card mentioned in ordinary output. */
export function interactionIdOf(call: { name: string; status: string; detail?: unknown; error?: unknown }): string | null {
  if (botToolName(call.name) !== "show_card" || call.status !== "completed" || call.error) return null;
  let visited = 0;
  const receipt = (value: unknown, depth = 0): string | null => {
    if (depth > 5 || ++visited > 32) return null;
    if (typeof value === "string") {
      if (value.length > 200_000) return null;
      try { return receipt(JSON.parse(value), depth + 1); } catch { return null; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.isError === true) return null;
    const id = InteractionIdSchema.safeParse(record.cardId);
    if (id.success && ["pending", "submitting", "answered", "dismissed"].includes(String(record.status))) return id.data;
    if (Array.isArray(record.content)) for (const block of record.content.slice(0, 20)) {
      if (block?.type === "text") { const id = receipt(block.text, depth + 1); if (id) return id; }
    }
    return null;
  };
  return receipt((call.detail as { output?: unknown } | null)?.output);
}

/** Dates are calendar values; parsing them as instants would move them across timezones. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function initialInteractionResponse(spec: InteractionSpec): InteractionResponse {
  return {
    action: "submit",
    values: spec.kind === "form" || spec.kind === "draft" ? Object.fromEntries(spec.fields.map((field) => [field.id, field.value])) : {},
    selected: [],
    text: spec.kind === "draft" ? spec.text : "",
  };
}

/** Validate against the stored card, never against a spec supplied by the responding client. */
export function validateInteractionResponse(spec: InteractionSpec, input: unknown): InteractionResponse {
  const response = InteractionResponseSchema.parse(input);
  if (response.action === "dismiss") {
    if (response.text || response.selected.length || Object.keys(response.values).length) throw new Error("A dismissal cannot contain answers.");
    return response;
  }
  if (spec.kind === "confirm") {
    if (!spec.actions.some((action) => action.id === response.action)) throw new Error("Choose one of the available actions.");
  } else if (response.action !== "submit") throw new Error("This card only accepts a submitted answer.");
  if (spec.kind === "choice") {
    if (!response.selected.length) throw new Error("Choose at least one option.");
    if (!spec.multiple && response.selected.length !== 1) throw new Error("Choose one option.");
    if (new Set(response.selected).size !== response.selected.length || response.selected.some((id) => !spec.options.some((option) => option.id === id))) throw new Error("Choose only the available options, once each.");
  } else if (response.selected.length) throw new Error("This card has no choices.");
  const fields = spec.kind === "form" || spec.kind === "draft" ? spec.fields : [];
  if (Object.keys(response.values).some((id) => !fields.some((field) => field.id === id))) throw new Error("This card does not contain that field.");
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = response.values[field.id] ?? "";
    if (field.required && !value.trim()) throw new Error(`${field.label} is required.`);
    if (field.kind === "select" && value && !field.options.includes(value)) throw new Error(`Choose an available value for ${field.label}.`);
    if (field.kind === "date" && value && !isCalendarDate(value)) throw new Error(`${field.label} must be a real date in YYYY-MM-DD format.`);
    values[field.id] = value;
  }
  if (spec.kind === "draft") {
    if (!response.text.trim()) throw new Error("The draft cannot be empty.");
  } else if (response.text) throw new Error("This card does not accept draft text.");
  return { ...response, values, selected: [...response.selected].sort() };
}

/** Stable serialization also lets a lost-response retry prove that it contains the same answer. */
export function responseSignature(response: InteractionResponse): string {
  return JSON.stringify({ ...response, values: Object.fromEntries(Object.entries(response.values).sort(([a], [b]) => a.localeCompare(b))), selected: [...response.selected].sort() });
}

export function interactionReplyText(card: Interaction, response: InteractionResponse): string {
  const action = card.spec.kind === "confirm" ? card.spec.actions.find((entry) => entry.id === response.action)?.label ?? response.action : response.action;
  const selected = card.spec.kind === "choice" ? response.selected.map((id) => ({ id, label: card.spec.kind === "choice" ? card.spec.options.find((option) => option.id === id)!.label : id })) : [];
  const payload = { cardId: card.id, title: card.spec.title, kind: card.spec.kind, action, values: response.values, selected, ...(card.spec.kind === "draft" && response.action !== "dismiss" ? { draft: response.text } : {}) };
  return `I ${response.action === "dismiss" ? "dismissed" : "answered"} your interactive card. Here is my response:\n\n${JSON.stringify(payload, null, 2)}\n\n${response.action === "dismiss" ? "Do not perform the proposed action." : "Use these answers for the request this card belongs to. This response grants no permissions beyond the action and content shown on that card."}`;
}

export function interactionSearchText(card: Interaction): string {
  return [card.spec.title, card.spec.description, card.spec.kind === "draft" ? card.response?.text || card.spec.text : card.spec.kind === "confirm" ? card.spec.preview : "", ...Object.values(card.response?.values ?? {})].join("\n");
}

/** Presentation only: the exact stored message remains the source for provider delivery and copy. */
export function interactionReplySummary(card: Interaction, text: string, messageIds: readonly string[]): string | null {
  if (!card.response || card.status === "pending" || !messageIds.length || messageIds.some((id) => id !== `bots-card-${card.id}`)) return null;
  let response: InteractionResponse;
  try { response = validateInteractionResponse(card.spec, card.response); } catch { return null; }
  if (text !== interactionReplyText(card, response)) return null;
  const { spec } = card;
  if (response.action === "dismiss") return `${spec.title}\nDismissed`;
  if (spec.kind === "confirm") return `${spec.title}\n${spec.actions.find((action) => action.id === response.action)!.label}`;
  if (spec.kind === "choice") return `${spec.title}\n${spec.options.filter((option) => response.selected.includes(option.id)).map((option) => option.label).join(", ")}`;
  const fields = spec.fields.map((field) => `${field.label}: ${response.values[field.id] || "Not provided"}`).join("\n");
  return [spec.title, spec.kind === "draft" ? "Approved draft" : "Answers submitted", fields, spec.kind === "draft" ? response.text : ""].filter(Boolean).join("\n\n");
}
