import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsGet } from "@/services/connectors/linkedin-ads/http";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "./_wallet";

const inputSchema = z
  .object({
    account_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    kind: z.enum(["images", "videos"]).default("images").describe("Which media library to list."),
    limit: z.number().int().min(1).max(100).default(25).describe("Most items to return, newest first."),
  })
  .strict();

const mediaSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  owner: z.string().optional(),
  downloadUrl: z.string().optional(),
  downloadUrlExpiresAt: z.number().optional(),
  duration: z.number().optional(),
  thumbnail: z.string().optional(),
  aspectRatioWidth: z.number().optional(),
  aspectRatioHeight: z.number().optional(),
  mediaLibraryMetadata: z.object({ associatedAccount: z.string().optional(), assetName: z.string().optional(), mediaLibraryStatus: z.string().optional() }).optional(),
});

export type LinkedInMediaItem = {
  urn: string;
  kind: "image" | "video";
  name: string | null;
  status: string | null;
  library_status: string | null;
  download_url: string | null;
  download_url_expires_at: string | null;
  duration_ms: number | null;
  thumbnail_url: string | null;
  aspect_ratio: string | null;
};

export async function listLinkedInMediaWithToken(token: string, accountId: string, kind: "images" | "videos", limit: number): Promise<{ media: LinkedInMediaItem[]; total: number | null }> {
  const page = await linkedinAdsGet<{ elements?: unknown[]; paging?: { total?: number } }>(token, kind, { q: "associatedAccount", associatedAccount: `urn:li:sponsoredAccount:${accountId}`, start: 0, count: limit }, {}, { fresh: true });
  if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", `LinkedIn did not list this account's ${kind} clearly. Try again in a few minutes.`);
  const media: LinkedInMediaItem[] = [];
  for (const raw of page.elements) {
    const m = mediaSchema.safeParse(raw);
    if (!m.success) continue;
    const account = m.data.mediaLibraryMetadata?.associatedAccount;
    if (account && account !== `urn:li:sponsoredAccount:${accountId}`) continue;
    media.push({
      urn: m.data.id,
      kind: kind === "images" ? "image" : "video",
      name: m.data.mediaLibraryMetadata?.assetName ?? null,
      status: m.data.status ?? null,
      library_status: m.data.mediaLibraryMetadata?.mediaLibraryStatus ?? null,
      download_url: m.data.downloadUrl ?? null,
      download_url_expires_at: typeof m.data.downloadUrlExpiresAt === "number" ? new Date(m.data.downloadUrlExpiresAt).toISOString() : null,
      duration_ms: typeof m.data.duration === "number" ? m.data.duration : null,
      thumbnail_url: m.data.thumbnail ?? null,
      aspect_ratio: typeof m.data.aspectRatioWidth === "number" && typeof m.data.aspectRatioHeight === "number" ? `${m.data.aspectRatioWidth}:${m.data.aspectRatioHeight}` : null,
    });
  }
  return { media, total: typeof page.paging?.total === "number" ? page.paging.total : null };
}

export const linkedinAdsListMediaTool: ToolSpec = {
  name: "linkedin_ads_list_media",
  effect: "read",
  description:
    "List the images or videos in one LinkedIn Ads account's media library, newest first, with each asset's URN (what a new ad's image_urn takes), name, processing status and a short-lived download URL. Only assets registered to the account's library appear; an image uploaded straight to a post is not listed. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (!(await linkedinAccountInUse(ctx.tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
    const { media, total } = await withLinkedInAdsToken(ctx.tenant_id, (token) => listLinkedInMediaWithToken(token, args.account_id, args.kind, args.limit));
    return { account_id: args.account_id, kind: args.kind, media, total, truncated: total !== null ? total > media.length : media.length >= args.limit, source: "media_library" };
  },
};
