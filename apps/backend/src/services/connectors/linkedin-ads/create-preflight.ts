import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { linkedinAdsGet, type RestliValue } from "./http";
import { linkedinCampaignTargeting, type linkedinBundleCampaign } from "./write";

export const LINKEDIN_MIN_AUDIENCE = 300;

const audienceCountsSchema = z.object({
  elements: z.array(z.object({ total: z.number().int().nonnegative() })).length(1),
});

type SkipReason = "rate_limited" | "read_failed" | "unrecognised_shape";

async function logSkipped(tenantId: string, reason: SkipReason, httpStatus?: unknown): Promise<void> {
  await logEvent({
    level: "warn",
    source: "linkedin-ads",
    code: "linkedin_ads.create_check_skipped",
    tenant_id: tenantId,
    message: "The LinkedIn audience-size check could not be completed, so Create was allowed without it.",
    meta: { stage: "audience_check", skipped_reason: reason, ...(typeof httpStatus === "number" ? { http_status: httpStatus } : {}) },
  });
}

export async function linkedinCreateRefusal(
  tenantId: string,
  campaign: z.infer<typeof linkedinBundleCampaign>,
  getToken: () => Promise<string>,
): Promise<string | null> {
  let body: unknown;
  try {
    const targetingCriteria = linkedinCampaignTargeting(campaign) as unknown as RestliValue;
    body = await linkedinAdsGet(await getToken(), "audienceCounts", { q: "targetingCriteriaV2", targetingCriteria }, {}, { advisory: true });
  } catch (e) {
    const status = e instanceof ExpectedToolError ? e.meta?.http_status : undefined;
    await logSkipped(tenantId, status === 429 ? "rate_limited" : "read_failed", status);
    return null;
  }
  const parsed = audienceCountsSchema.safeParse(body);
  if (!parsed.success) {
    await logSkipped(tenantId, "unrecognised_shape");
    return null;
  }
  if (parsed.data.elements[0].total >= LINKEDIN_MIN_AUDIENCE) return null;
  return `This audience is under LinkedIn's minimum of ${LINKEDIN_MIN_AUDIENCE} members. Nothing was created. Add more locations or widen the professional audience, then try again.`;
}
