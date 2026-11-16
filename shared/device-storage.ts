import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Private to this installation on this device; never sent to a bot or exported. */
export const deviceStorage = defineSettings({
  id: "drafts",
  scope: "device",
  version: 1,
  schema: z.object({
    items: z.record(z.string().max(500), z.object({ value: z.string().max(2_100_000), updatedAt: z.number().finite() })).default({}),
  }),
});
export type DeviceStorageValues = z.infer<typeof deviceStorage.schema>;
