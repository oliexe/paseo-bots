// Composer attachments and their wire format (Paseo's `images` and AgentAttachment).

export type ComposerAttachment =
  | { kind: "image"; id: string; name: string; mimeType: string; size: number; data: string }
  | { kind: "text"; id: string; name: string; size: number; text: string }
  | { kind: "file"; id: string; name: string; mimeType: string; size: number; path: string };

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX_BYTES = 1024 * 1024;
const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Raster images Paseo sends as `images` (the provider-readable formats). */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|bash|sql|log|ini|cfg|conf|env|graphql|vue|svelte)$/i;

export type AttachmentKind = "image" | "text" | "file";

export function classifyFile(name: string, mimeType: string): AttachmentKind {
  if (IMAGE_TYPES.has(mimeType.toLowerCase())) return "image";
  if (mimeType.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|javascript|typescript|sql)/.test(mimeType) || TEXT_EXTENSIONS.test(name)) return "text";
  return "file";
}

/** Classifies a file and checks its size before any bytes are read. */
export function preflightFile(name: string, mimeType: string, size: number, canUpload: boolean): { kind: AttachmentKind; reason: string | null } {
  let kind = classifyFile(name, mimeType);
  if (kind === "text" && size > TEXT_MAX_BYTES) kind = "file";
  return { kind, reason: rejectReason(kind, size, canUpload) };
}

/** Normalises clipboard/drop MIME types (`image/jpg`, parameters) the way Paseo does. */
export function normalizeMimeType(mimeType: string): string {
  const base = (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

/** Paseo's pill subtitle (attachments/file-types.ts getFileTypeLabel): the extension in capitals. */
export function getFileTypeLabel(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const extension = base.slice(dot + 1);
  return /^[a-z0-9]+$/i.test(extension) ? extension.toUpperCase() : null;
}

/** Why a picked file can't be attached, or null. */
export function rejectReason(kind: AttachmentKind, size: number, canUpload: boolean): string | null {
  if (kind === "image" && size > IMAGE_MAX_BYTES) return "Images can be up to 10 MB.";
  if (kind === "text" && size > TEXT_MAX_BYTES) return canUpload ? null : "Text files can be up to 1 MB.";
  if (kind === "file" && !canUpload) return "Other files can only be attached for bots running on this host.";
  if (size > FILE_MAX_BYTES) return "Files can be up to 25 MB.";
  return null;
}

type WireImage = { data: string; mimeType: string };
export type WireAttachment =
  | { type: "text"; mimeType: "text/plain"; title: string; text: string }
  | { type: "uploaded_file"; id: string; fileName: string; mimeType: string; size: number; path: string };

export function toWire(attachments: readonly ComposerAttachment[]): { images: WireImage[]; attachments: WireAttachment[] } {
  const images: WireImage[] = [];
  const rest: WireAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") images.push({ data: attachment.data, mimeType: attachment.mimeType });
    else if (attachment.kind === "text") rest.push({ type: "text", mimeType: "text/plain", title: attachment.name, text: attachment.text });
    else rest.push({ type: "uploaded_file", id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType, size: attachment.size, path: attachment.path });
  }
  return { images, attachments: rest };
}

export function newAttachmentId(): string {
  return "att-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
