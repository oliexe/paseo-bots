import { Platform } from "react-native";

// Web-only DOM helpers for the composer and avatars: file picking, clipboard images, drag and
// drop, picture scaling, textarea measuring and focus. Pickers are no-ops off the web.
// This plugin typechecks without the DOM library. Declare only what this module uses.

interface DomFile {
  name: string;
  type: string;
  size: number;
}
interface DomStyle {
  [property: string]: string | undefined;
}
interface DomInput {
  type: string;
  multiple: boolean;
  accept: string;
  style: { display: string };
  files: ArrayLike<DomFile> | null;
  onchange: (() => void) | null;
  addEventListener(type: "cancel", listener: () => void): void;
  click(): void;
  remove(): void;
}
interface DomTextArea {
  value: string;
  rows: number;
  readOnly: boolean;
  scrollHeight: number;
  style: DomStyle;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
interface DomDiv {
  style: DomStyle;
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
interface DataTransferLike {
  types?: ArrayLike<string>;
  files?: ArrayLike<DomFile>;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): DomFile | null }>;
  dropEffect?: string;
}
interface DomEvent {
  preventDefault(): void;
  stopPropagation(): void;
  clipboardData?: DataTransferLike | null;
  dataTransfer?: DataTransferLike | null;
}
/** A DOM element as far as this module is concerned. */
export interface DomElement {
  clientWidth: number;
  parentElement?: DomElement | null;
  addEventListener(type: string, listener: (event: DomEvent) => void): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void): void;
  appendChild?(node: unknown): void;
  focus?(): void;
}
interface DomImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decode(): Promise<void>;
}
interface DomCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): { imageSmoothingQuality: string; drawImage(image: DomImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void } | null;
  toDataURL(type: string, quality: number): string;
}
declare const document: {
  createElement(tag: "input"): DomInput;
  createElement(tag: "textarea"): DomTextArea;
  createElement(tag: "div"): DomDiv;
  createElement(tag: "img"): DomImage;
  createElement(tag: "canvas"): DomCanvas;
  body: { appendChild(node: unknown): void };
  activeElement: unknown;
};
declare const window: { getComputedStyle(element: unknown): DomStyle };
declare class FileReader {
  result: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: DomFile): void;
}

const web = Platform.OS === "web";

export interface PickedFile {
  name: string;
  mimeType: string;
  size: number;
  /** File contents, base64 without the data: prefix. */
  base64: string;
}

/** A picked, pasted or dropped file whose size is known before its bytes are read. */
export interface FileHandle {
  name: string;
  mimeType: string;
  size: number;
  readBase64(): Promise<string>;
}

/** Native has no file picker available to plugins; web uses a hidden file input like Paseo's own composer. */
export const canPickFiles = web;

function readBase64(file: DomFile): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function toHandle(file: DomFile): FileHandle {
  return { name: file.name || "file", mimeType: file.type || "application/octet-stream", size: file.size, readBase64: () => readBase64(file) };
}

/** Opens the browser's file picker. Resolves with lazy handles so sizes can be checked before reading. */
export function pickFileHandles(options: { accept?: string; multiple?: boolean } = {}): Promise<FileHandle[]> {
  if (!web) return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? true;
    if (options.accept) input.accept = options.accept;
    input.style.display = "none";
    let done = false;
    const finish = (files: FileHandle[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish(Array.from(input.files ?? []).map(toHandle));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** A picture as a small square WebP data URL: its centre, scaled down to `size` pixels (avatars). */
export async function squareImage(source: string, size: number): Promise<string> {
  const image = document.createElement("img");
  image.src = source;
  await image.decode();
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!side || !context) throw new Error("That picture couldn't be read.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/webp", 0.85);
}

export function decodeUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The DOM node behind a React Native ref on web (react-native-web refs are the host elements). */
export function domNode(ref: unknown): DomElement | null {
  if (!web || !ref || typeof ref !== "object") return null;
  const candidate = ref as Partial<DomElement> & { getNativeRef?: () => unknown };
  if (typeof candidate.addEventListener === "function") return candidate as DomElement;
  const inner = candidate.getNativeRef?.();
  return inner && typeof (inner as DomElement).addEventListener === "function" ? (inner as DomElement) : null;
}

/** Scrolls a React Native view's element to the middle of its scroller (web; list estimates can be off for tall rows). */
export function scrollIntoView(ref: unknown): void {
  const node = domNode(ref) as (DomElement & { scrollIntoView?(options: { block: string; behavior: string }): void }) | null;
  node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}

/** Calls `onFind` for ⌘F / Ctrl+F instead of the browser's own find. */
export function listenForFind(onFind: () => void): () => void {
  const target = globalThis as { addEventListener?(type: "keydown", listener: (event: KeyEventLike) => void, capture: boolean): void; removeEventListener?(type: "keydown", listener: (event: KeyEventLike) => void, capture: boolean): void };
  if (!web || !target.addEventListener) return () => {};
  const handler = (event: KeyEventLike) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    onFind();
  };
  target.addEventListener("keydown", handler, true);
  return () => target.removeEventListener?.("keydown", handler, true);
}
interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

// ---------------------------------------------------------------- clipboard images

function clipboardFiles(data: DataTransferLike | null | undefined): DomFile[] {
  if (!data) return [];
  const files: DomFile[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) files.push(...Array.from(data.files ?? []));
  return files;
}

/**
 * Paseo's usePasteImagesEffect: pasting images into the textarea attaches them instead of
 * inserting anything. Text pastes are left alone.
 */
export function listenForImagePaste(element: DomElement | null, onImages: (files: FileHandle[]) => void): () => void {
  if (!web || !element) return () => {};
  const handler = (event: DomEvent) => {
    const images = clipboardFiles(event.clipboardData).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    onImages(
      images.map((file, index) => {
        // Screenshots arrive as a generic "image.png"; name them like pasted files.
        const generic = !file.name || /^image\.\w+$/i.test(file.name);
        const extension = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        return { ...toHandle(file), name: generic ? `Pasted image ${index + 1}.${extension}` : file.name };
      }),
    );
  };
  element.addEventListener("paste", handler);
  return () => element.removeEventListener("paste", handler);
}

// ---------------------------------------------------------------- drag and drop

// Lucide "upload" (Paseo's drop backdrop icon), inlined because this overlay is plain DOM.
const UPLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';

function hasFiles(data: DataTransferLike | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}

/**
 * Paseo's FileDropZone for the chat pane: dragging files over `zone` dims it with the
 * "Drop files here" backdrop, and dropping hands the files over.
 */
export function listenForFileDrop(
  zone: DomElement | null,
  options: { label: string; background: string; foreground: string; isEnabled(): boolean; onFiles(files: FileHandle[]): void },
): () => void {
  if (!web || !zone || typeof zone.appendChild !== "function") return () => {};
  let depth = 0;
  let overlay: DomDiv | null = null;
  const show = () => {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      zIndex: "1000",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      pointerEvents: "none",
      color: options.foreground,
    });
    overlay.innerHTML = `<div style="position:absolute;inset:0;background:${options.background};opacity:0.7"></div><div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:8px">${UPLOAD_SVG}<div style="font-size:14px;font-weight:500">${options.label}</div></div>`;
    zone.appendChild!(overlay);
  };
  const hide = () => {
    depth = 0;
    overlay?.remove();
    overlay = null;
  };
  const onEnter = (event: DomEvent) => {
    if (!hasFiles(event.dataTransfer) || !options.isEnabled()) return;
    event.preventDefault();
    depth += 1;
    show();
  };
  const onOver = (event: DomEvent) => {
    if (!hasFiles(event.dataTransfer) || !options.isEnabled()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    show();
  };
  const onLeave = (event: DomEvent) => {
    if (!hasFiles(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  };
  const onDrop = (event: DomEvent) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    hide();
    if (!options.isEnabled()) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) options.onFiles(files.map(toHandle));
  };
  zone.addEventListener("dragenter", onEnter);
  zone.addEventListener("dragover", onOver);
  zone.addEventListener("dragleave", onLeave);
  zone.addEventListener("drop", onDrop);
  return () => {
    zone.removeEventListener("dragenter", onEnter);
    zone.removeEventListener("dragover", onOver);
    zone.removeEventListener("dragleave", onLeave);
    zone.removeEventListener("drop", onDrop);
    hide();
  };
}

// ---------------------------------------------------------------- textarea height

const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "wordWrap",
  "overflowWrap",
  "wordBreak",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

export interface TextMeasurer {
  /** Content height of `text` laid out like `source`, or null when it can't be measured yet. */
  measure(source: DomElement | null, text: string): number | null;
  dispose(): void;
}

/** Paseo's composer/input/height.web.ts: a hidden mirror textarea measures the draft's scrollHeight. */
export function createTextMeasurer(): TextMeasurer | null {
  if (!web || typeof document === "undefined") return null;
  const mirror = document.createElement("textarea");
  mirror.setAttribute("aria-hidden", "true");
  mirror.setAttribute("tabindex", "-1");
  mirror.readOnly = true;
  mirror.rows = 1;
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
    border: "0",
    margin: "0",
    resize: "none",
    zIndex: "-1",
    boxSizing: "border-box",
    height: "0",
  });
  document.body.appendChild(mirror);
  return {
    measure(source, text) {
      if (!source || source.clientWidth <= 0) return null;
      const computed = window.getComputedStyle(source);
      for (const property of COPIED_STYLES) mirror.style[property] = computed[property];
      mirror.style.width = `${source.clientWidth}px`;
      mirror.value = text.endsWith("\n") ? `${text} ` : text;
      return mirror.scrollHeight;
    },
    dispose: () => mirror.remove(),
  };
}

type ResizeObserverLike = { observe(target: unknown): void; disconnect(): void };
const ResizeObserverCtor = (globalThis as { ResizeObserver?: new (callback: () => void) => ResizeObserverLike }).ResizeObserver;

/** Calls back when the element's width changes (the draft re-wraps). */
export function observeWidth(element: DomElement | null, onChange: () => void): () => void {
  if (!web || !element || !ResizeObserverCtor) return () => {};
  let width = element.clientWidth;
  const observer = new ResizeObserverCtor(() => {
    if (Math.abs(element.clientWidth - width) < 1) return;
    width = element.clientWidth;
    onChange();
  });
  observer.observe(element);
  return () => observer.disconnect();
}

// ---------------------------------------------------------------- focus

/** utils/web-focus.ts focusWithRetries: keeps trying for a moment while the surface mounts. */
export function focusWithRetries(element: () => DomElement | null, timeoutMs = 1500): () => void {
  if (!web) return () => {};
  let cancelled = false;
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (cancelled) return;
    const node = element();
    try {
      node?.focus?.();
    } catch {
      // ignore
    }
    if ((node && document.activeElement === node) || Date.now() >= deadline) return;
    requestAnimationFrame(() => requestAnimationFrame(tick));
  };
  requestAnimationFrame(tick);
  return () => {
    cancelled = true;
  };
}
