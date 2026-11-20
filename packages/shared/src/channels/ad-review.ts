import { z } from "zod";
import { AD_IMAGE_PATH_RE } from "./ad-approval";

const webUrl = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});

export const adReviewCreativeSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  image_url: webUrl.optional(),
  image_path: z.string().regex(AD_IMAGE_PATH_RE).optional(),
  image_artifact_id: z.string().uuid().optional(),
  video_url: webUrl.optional(),
  media_kind: z.enum(["image", "video"]).optional(),
  youtube_video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  target_url: webUrl.optional(),
  advertiser: z.string().optional(),
  call_to_action: z.string().optional(),
  source: z.string().optional(),
  headlines: z.array(z.string()).optional(),
  descriptions: z.array(z.string()).optional(),
});

export const adReviewPresentationSchema = z.object({
  creatives: z.array(adReviewCreativeSchema),
  cost: z.string().optional(),
  provenance: z.string().optional(),
  schedule: z.object({ start: z.string().nullable(), end: z.string().nullable() }).optional(),
  revision: z.string().optional(),
});

export const adReviewEditFieldSchema = z.object({
  key: z.string(), label: z.string(), value: z.string(),
  kind: z.enum(["text", "multiline", "lines", "url", "date", "datetime"]),
  optional: z.boolean(),
});
export const adReviewChangesSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.record(z.string().max(160), z.string().max(10000)).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50),
}).strict();
export type AdReviewChanges = z.infer<typeof adReviewChangesSchema>;
export type AdReviewEditField = z.infer<typeof adReviewEditFieldSchema>;
export interface AdRecommendation { reason: string; }
export interface AdReviewResponse {
  review: AdReviewPresentation | null;
  fields: AdReviewEditField[];
  editable: boolean;
  limitations: string[];
  connection_blocker: { message: string } | null;
}

export type AdReviewCreative = z.infer<typeof adReviewCreativeSchema>;
export type AdReviewPresentation = z.infer<typeof adReviewPresentationSchema>;
