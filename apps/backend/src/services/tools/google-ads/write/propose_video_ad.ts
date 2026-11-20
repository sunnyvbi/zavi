import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { videoFormatSchema } from "./_decision-bodies";
import { isYoutubeVideoId } from "./_video-formats";
import { VIDEO_CREATE_UNSUPPORTED } from "./propose_video_campaign";

const youtubeVideoId = z.string().refine(isYoutubeVideoId, "must be an 11-character YouTube video id");
const text = (max: number) => z.string().trim().min(1).max(max);

const inputSchema = z.object({
  ad_group_id: z.string().regex(/^[0-9]+$/).describe("A VIDEO_* ad group whose type matches the format (from google_ads__list_ad_groups)."),
  format: videoFormatSchema,
  youtube_video_ids: z.array(youtubeVideoId).min(1).max(5),
  final_url: z.string().url().optional(),
  headlines: z.array(text(100)).max(5).default([]),
  long_headlines: z.array(text(90)).max(5).default([]),
  descriptions: z.array(text(90)).max(5).default([]),
  call_to_action: z.string().trim().max(10).optional(),
  rationale: rationaleInput(),
  name: z.string().optional().describe("A short label for the ad."),
  about: z.string().optional().describe("ONE plain sentence on what the video shows."),
});

export const googleProposeVideoAdTool: ToolSpec = {
  name: "google_ads_propose_video_ad",
  effect: "write",
  description:
    "NOT AVAILABLE: Google's Ads API cannot create or change anything in a YouTube VIDEO campaign, including adding a video ad to one of its ad groups, so this tool refuses every call. Write a precise manual setup card for the founder instead.",
  input_schema: inputSchema,
  async execute() {
    throw new ExpectedToolError("google_ads_video_create_unsupported", VIDEO_CREATE_UNSUPPORTED);
  },
};
