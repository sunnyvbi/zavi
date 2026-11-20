
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { fbGet, metaAdsCreds } from "./_client";

const LIMIT = 50;

const FIELDS: Record<"creatives" | "images" | "videos", { edge: string; fields: string }> = {
  creatives: {
    edge: "adcreatives",
    fields: "id,name,status,title,body,image_url,image_hash,thumbnail_url,video_id,call_to_action_type,object_story_spec{link_data{link},video_data{call_to_action}}",
  },
  images: { edge: "adimages", fields: "id,hash,name,url,width,height,status,created_time" },
  videos: { edge: "advideos", fields: "id,title,length,status,picture,created_time" },
};

const listInput = z.object({
  kind: z.enum(["creatives", "images", "videos"]),
  limit: z.number().int().min(1).max(LIMIT).optional().describe(`Up to ${LIMIT}, newest first.`),
});

export const metaListCreativeAssetsTool: ToolSpec = {
  name: "meta_ads_list_creative_assets",
  effect: "read",
  description:
    "List the ad account's creatives, images or videos (ids, names, image hashes, video ids, copy). Use it to find a creative to swap an ad onto, or an uploaded image/video to build a creative from.",
  input_schema: listInput,
  async execute(ctx, input) {
    const a = listInput.parse(input);
    const creds = await metaAdsCreds(ctx.tenant_id);
    const f = FIELDS[a.kind];
    const limit = a.limit ?? 25;
    const r = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/${f.edge}`, { fields: f.fields, limit })) as {
      data?: Array<Record<string, unknown>>;
      paging?: { next?: string };
    };
    return { kind: a.kind, items: r.data ?? [], truncated: !!r.paging?.next };
  },
};

const PREVIEW_FORMATS = [
  "DESKTOP_FEED_STANDARD",
  "MOBILE_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "FACEBOOK_STORY_MOBILE",
  "INSTAGRAM_REELS",
] as const;

const previewInput = z.object({
  ad_id: z.string().optional(),
  creative_id: z.string().optional(),
  ad_format: z.enum(PREVIEW_FORMATS).optional().describe("Default MOBILE_FEED_STANDARD."),
});

export function previewLink(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const m = body.match(/src="([^"]+)"/);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

export const metaPreviewTool: ToolSpec = {
  name: "meta_ads_preview",
  effect: "read",
  description:
    "Meta's own rendered preview of an ad or a creative in a placement (feed, story, reels). Returns a link the founder can open to see exactly what will show.",
  input_schema: previewInput,
  async execute(ctx, input) {
    const a = previewInput.parse(input);
    const id = a.ad_id ?? a.creative_id;
    if (!id || (a.ad_id && a.creative_id)) {
      throw new ExpectedToolError("meta_ads_invalid_target", "Give exactly one of ad_id or creative_id.");
    }
    const creds = await metaAdsCreds(ctx.tenant_id);
    const own = (await fbGet(ctx.tenant_id, id, { fields: "account_id" })) as { account_id?: string };
    if (!own?.account_id || own.account_id.replace(/^act_/, "") !== creds.ad_account_id.replace(/^act_/, "")) {
      throw new ExpectedToolError("meta_ads_invalid_target", `${id} is not in this workspace's ad account.`);
    }
    const ad_format = a.ad_format ?? "MOBILE_FEED_STANDARD";
    const r = (await fbGet(ctx.tenant_id, `${id}/previews`, { ad_format })) as { data?: Array<{ body?: string }> };
    const link = previewLink(r.data?.[0]?.body);
    if (!link) throw new ExpectedToolError("meta_ads_preview_unavailable", "Meta returned no preview for this placement.");
    return { ad_format, preview_url: link };
  },
};
