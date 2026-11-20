import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsGet } from "@/services/connectors/linkedin-ads/http";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "./_wallet";

const inputSchema = z
  .object({
    account_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    creative_id: z.string().regex(/^\d{1,20}$/).describe("The ad (creative) id, from linkedin_ads_list_ads."),
  })
  .strict();

const previewSchema = z.object({
  preview: z.string().min(1),
  creative: z.string().optional(),
  placement: z.object({ linkedin: z.object({ placementName: z.string().optional(), contentPresentationType: z.string().optional() }).optional() }).optional(),
});

export type LinkedInAdPreview = { placement: string | null; presentation: string | null; preview_html: string; preview_url: string | null };

export const previewUrlOf = (html: string): string | null => /\bsrc=['"]([^'"]+)['"]/.exec(html)?.[1] ?? null;

export async function readLinkedInAdPreviewsWithToken(token: string, accountId: string, creativeId: string): Promise<LinkedInAdPreview[]> {
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adPreviews", { q: "creative", creative: `urn:li:sponsoredCreative:${creativeId}`, account: `urn:li:sponsoredAccount:${accountId}` }, {}, { fresh: true });
  if (!Array.isArray(response.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not answer the preview request clearly. Try again in a few minutes.");
  const out: LinkedInAdPreview[] = [];
  for (const raw of response.elements) {
    const p = previewSchema.safeParse(raw);
    if (!p.success || (p.data.creative && p.data.creative !== `urn:li:sponsoredCreative:${creativeId}`)) continue;
    out.push({ placement: p.data.placement?.linkedin?.placementName ?? null, presentation: p.data.placement?.linkedin?.contentPresentationType ?? null, preview_html: p.data.preview, preview_url: previewUrlOf(p.data.preview) });
  }
  return out;
}

export const linkedinAdsPreviewAdTool: ToolSpec = {
  name: "linkedin_ads_preview_ad",
  effect: "read",
  description:
    "Get LinkedIn's rendered preview of one existing ad (creative) as it shows in the feed on desktop and mobile. Returns the iframe HTML and the preview URL LinkedIn serves, valid for about three hours. Works for single image, carousel, video, job and event ads. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (!(await linkedinAccountInUse(ctx.tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
    const previews = await withLinkedInAdsToken(ctx.tenant_id, (token) => readLinkedInAdPreviewsWithToken(token, args.account_id, args.creative_id));
    if (!previews.length) throw new ExpectedToolError("linkedin_ads_preview_unavailable", "LinkedIn has no preview for this ad. It may be a format LinkedIn does not render, or the ad may not be in this account.");
    const desktop = previews.find((p) => p.presentation === "DESKTOP_WEBSITE") ?? previews[0];
    return { creative_id: args.creative_id, preview_html: desktop.preview_html, preview_url: desktop.preview_url, previews, expires_note: "LinkedIn preview iframes expire after about three hours; call again for a fresh one." };
  },
};
