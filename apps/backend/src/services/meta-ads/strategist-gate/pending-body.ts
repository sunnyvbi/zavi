
import { z } from "zod";
import { createAdSetBodySchema } from "@/services/tools/meta-ads/write/_decision-bodies";
import type { CreateAdSetBody } from "@/services/tools/meta-ads/write/_decision-bodies";
import { PENDING_STRATEGIST_KIND } from "./constants";

export const pendingStrategistBodySchema = z.object({
  kind: z.literal(PENDING_STRATEGIST_KIND),
  create_ad_set: createAdSetBodySchema,
  promoted_event: z.string().min(1).max(200).optional(),
  cold_event: z.boolean().optional(),
});

export type PendingStrategistBody = z.infer<typeof pendingStrategistBodySchema>;

export function buildPendingStrategistBody(
  create: CreateAdSetBody,
  opts?: { promoted_event?: string; cold_event?: boolean },
): PendingStrategistBody {
  return {
    kind: PENDING_STRATEGIST_KIND,
    create_ad_set: create,
    ...(opts?.promoted_event ? { promoted_event: opts.promoted_event } : {}),
    ...(opts?.cold_event !== undefined ? { cold_event: opts.cold_event } : {}),
  };
}

export function isPendingStrategistBody(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { kind?: unknown }).kind === PENDING_STRATEGIST_KIND
  );
}
