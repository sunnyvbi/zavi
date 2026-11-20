import { z } from "zod";
import type { ActionItem } from "../types";

const webUrl = z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://"));

const campaignCreative = z.object({
  type: z.literal("campaign_draft"),
  ads: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    target_url: webUrl,
    image_url: webUrl.optional(),
  })).min(1),
});

export type AdCreative = z.infer<typeof campaignCreative>["ads"][number];

export function adCreatives(action: ActionItem): AdCreative[] {
  const result = campaignCreative.safeParse(action.body?.step?.deliverable?.presentation);
  return result.success ? result.data.ads : [];
}

export function adCreative(action: ActionItem): AdCreative | null {
  const creatives = adCreatives(action);
  return creatives.length === 1 ? creatives[0] : null;
}
