
import { createAdSetBodySchema } from "@/services/tools/meta-ads/write/_decision-bodies";
import type { CreateAdSetBody } from "@/services/tools/meta-ads/write/_decision-bodies";

export function reconstructCreateBody(parkedBody: unknown): CreateAdSetBody | null {
  if (!parkedBody || typeof parkedBody !== "object") return null;
  const nested = (parkedBody as { create_ad_set?: unknown }).create_ad_set;
  const parsed = createAdSetBodySchema.safeParse(nested);
  if (!parsed.success) return null;
  return parsed.data;
}

export type StrategistVerdictAnnotation = {
  reviewed_by: "growth-lead";
  verdict: "approve";
  reason: string;
};

export function buildVerdictAnnotation(reason: string): StrategistVerdictAnnotation {
  return {
    reviewed_by: "growth-lead",
    verdict: "approve",
    reason: (reason ?? "").trim().slice(0, 500),
  };
}
