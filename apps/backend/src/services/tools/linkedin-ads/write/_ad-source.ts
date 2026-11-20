import { z } from "zod";
import { assertPostFromPage, readPublicPost } from "@/services/connectors/linkedin-ads/post-link";
import type { LiRawCreative } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError } from "@/services/tools/types";
import type { LinkedInAdSource } from "../_change-bodies";

export const POST_URN = /^urn:li:(share|ugcPost):\d{1,25}$/;
export const ORGANIZATION_URN = /^urn:li:organization:\d+$/;
export const LINKEDIN_AD_LIMIT = 100;
export const ENDED_STATUSES = new Set(["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);

export const postUrnInput = z.string().regex(POST_URN, "post_urn must be urn:li:share:<id> or urn:li:ugcPost:<id>");

export const inlineAdInput = z
  .object({
    ad_name: z.string().trim().min(1).max(255).describe("The ad's name in Campaign Manager."),
    commentary: z.string().min(1).max(3000).describe("The ad's text, as the post body."),
    headline: z.string().max(200).optional().describe("Headline shown under the image or link."),
    landing_url: z.string().url().max(2000).optional().describe("Where a click goes. Without it the ad is a plain text or image post."),
    image_urn: z.string().regex(/^urn:li:image:[A-Za-z0-9_-]{1,80}$/).optional().describe("An image already uploaded to LinkedIn (urn:li:image:…)."),
  })
  .strict();

export const adSourceFields = {
  post_urn: postUrnInput.optional().describe("An existing post of the company page to promote. Pass this or inline, not both."),
  inline: inlineAdInput.optional().describe("A new direct ad written for this campaign. Pass this or post_urn, not both."),
};

export const exactlyOneSource = (v: { post_urn?: string; inline?: unknown }) => (v.post_urn ? 1 : 0) + (v.inline ? 1 : 0) === 1;
export const ONE_SOURCE_MESSAGE = "Pass exactly one of post_urn or inline.";

export function adSourceOf(v: { post_urn?: string; inline?: z.infer<typeof inlineAdInput> }): LinkedInAdSource {
  if (v.post_urn) return { kind: "post", post_urn: v.post_urn };
  if (!v.inline) throw new ExpectedToolError("linkedin_ads_source_required", ONE_SOURCE_MESSAGE);
  return { kind: "inline", ...v.inline };
}

export const countsAsAd = (a: LiRawCreative) => a.intendedStatus !== "PENDING_DELETION" && a.intendedStatus !== "ARCHIVED";

export function associatedEntityOf(live: unknown, label: string): string {
  const entity = (live as { associatedEntity?: unknown } | null)?.associatedEntity;
  if (typeof entity !== "string" || !ORGANIZATION_URN.test(entity))
    throw new ExpectedToolError("linkedin_ads_page_unknown", `LinkedIn did not say which company page ${label} advertises for, so Zavi cannot write an ad for it. Check the campaign in Campaign Manager.`);
  return entity;
}

export function refuseEnded(status: string | null, label: string, what: string): void {
  if (status && ENDED_STATUSES.has(status)) throw new ExpectedToolError("linkedin_ads_campaign_ended", `${label} is ${status.toLowerCase()}, so ${what}.`);
}

export function refuseAdLimit(ads: LiRawCreative[], label: string): void {
  if (ads.filter(countsAsAd).length >= LINKEDIN_AD_LIMIT)
    throw new ExpectedToolError("linkedin_ads_ad_limit", `${label} already has ${LINKEDIN_AD_LIMIT} ads, LinkedIn's limit per campaign. Archive one before adding another.`);
}

export async function checkPostSource(token: string, source: LinkedInAdSource, associatedEntity: string, ads: Array<LiRawCreative & { creative_id: string }>, label: string): Promise<void> {
  if (source.kind !== "post") return;
  const used = ads.find((a) => a.content?.reference === source.post_urn && countsAsAd(a));
  if (used) throw new ExpectedToolError("linkedin_ads_ad_exists", `${label} already runs the post ${source.post_urn} as ad ${used.creative_id}, so Zavi did not propose it again.`, { creative_id: used.creative_id });
  await assertPostFromPage(token, source.post_urn, associatedEntity, () => readPublicPost(source.post_urn));
}
