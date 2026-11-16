import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DesktopDisplaySchema = z.object({ id: z.number().int(), name: z.string(), width: z.number().positive(), height: z.number().positive() });
export type DesktopDisplay = z.infer<typeof DesktopDisplaySchema>;
export const DesktopStatusSchema = z.object({
  supported: z.boolean(), platform: z.string(), screenRecording: z.boolean(), accessibility: z.boolean(),
  displays: z.array(DesktopDisplaySchema), message: z.string().nullable(),
});
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;
const Session = z.string().regex(/^[a-f0-9]{48}$/);
export const desktopStatusRpc = defineRpc({ name: "desktop.status", input: z.object({}), output: DesktopStatusSchema });
export const desktopRequestAccessRpc = defineRpc({
  name: "desktop.request-access", input: z.object({ access: z.enum(["screen", "control"]) }), output: DesktopStatusSchema,
});
export const desktopStartRpc = defineRpc({
  name: "desktop.start", input: z.object({ control: z.boolean().default(false) }),
  output: z.object({ session: Session, expiresAt: z.string(), control: z.boolean(), status: DesktopStatusSchema }),
});
export const desktopStopRpc = defineRpc({ name: "desktop.stop", input: z.object({ session: Session }), output: z.object({ ok: z.boolean() }) });
export const desktopFrameRpc = defineRpc({
  name: "desktop.frame", input: z.object({ session: Session, displayId: z.number().int(), maxDimension: z.number().int().min(640).max(2560).default(1600) }),
  output: z.object({ image: z.string(), width: z.number().positive(), height: z.number().positive(), capturedAt: z.string() }),
});
const Point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
export const DESKTOP_KEYS = ["return", "tab", "escape", "space", "delete", "forwardDelete", "up", "down", "left", "right", "home", "end", "pageUp", "pageDown", "a", "c", "v", "x", "z", "l", "r", "f", "w", "t", "s", "q"] as const;
export const DesktopInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ...Point, button: z.enum(["left", "right"]).default("left"), count: z.number().int().min(1).max(2).default(1) }),
  z.object({ kind: z.literal("scroll"), ...Point, delta: z.number().int().min(-20).max(20) }),
  z.object({ kind: z.literal("drag"), ...Point, toX: Point.x, toY: Point.y }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("key"), key: z.enum(DESKTOP_KEYS), modifiers: z.array(z.enum(["command", "shift", "option", "control"])).max(4).default([]) }),
]);
export type DesktopInput = z.infer<typeof DesktopInputSchema>;
export const desktopInputRpc = defineRpc({
  name: "desktop.input", input: z.object({ session: Session, displayId: z.number().int(), input: DesktopInputSchema }), output: z.object({ ok: z.boolean() }),
});

/** Maps a press on a contained screenshot to its image; ignores letterboxing. */
export function desktopPoint(x: number, y: number, box: { width: number; height: number }, image: { width: number; height: number }): { x: number; y: number } | null {
  if (![x, y, box.width, box.height, image.width, image.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return null;
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  const px = (x - (box.width - width) / 2) / width, py = (y - (box.height - height) / 2) / height;
  return px >= 0 && px <= 1 && py >= 0 && py <= 1 ? { x: px, y: py } : null;
}
