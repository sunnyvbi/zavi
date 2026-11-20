
import { z } from "zod";
import { SOCIAL_LIMITS, X_THREAD_MAX_PARTS, xWeightedLength } from "@zavi/shared";
import { canonicalRedditUrl } from "@/services/channels/reddit/permalink";

export type SocialChannelAction = {
  vendor_review_pending?: string;
  app_slug: string;
  action_id: string;
  cost: "free" | "paid";
  enabled: boolean;
  payload_schema: z.ZodTypeAny;
  buildProps: (
    payload: Record<string, unknown>,
    destinationId?: string,
  ) => Record<string, unknown>;
  destination_required: boolean;
  media_prop?: string;
};

export type SocialPayload = Record<string, unknown>;

const linkedinPostSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.linkedin.text),
  })
  .strict();

const redditPostSchema = z
  .object({
    subreddit: z
      .string()
      .min(1)
      .max(21)
      .regex(/^[A-Za-z0-9_]+$/, "subreddit must be a bare display name"),
    title: z.string().min(1).max(SOCIAL_LIMITS.reddit.title),
    text: z.string().min(1).max(SOCIAL_LIMITS.reddit.text),
  })
  .strict();

const redditCommentSchema = z
  .object({
    thread_url: z
      .string()
      .max(500)
      .transform((u, ctx) => canonicalRedditUrl(u) ?? (ctx.addIssue({ code: "custom", message: "thread_url must be a reddit.com/r/<sub>/comments/<id> link" }), z.NEVER)),
    text: z.string().min(1).max(SOCIAL_LIMITS.reddit_comment.text),
  })
  .strict();

export const IMAGE_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;
export const VIDEO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/;

export { X_THREAD_MAX_PARTS } from "@zavi/shared";
export const xPostTextSchema = z.string().min(1).refine(text => text.trim().length > 0, { message: "Write something in every X post." }).refine(
  text => xWeightedLength(text).length <= SOCIAL_LIMITS.x.text,
  { message: `X posts must be at most ${SOCIAL_LIMITS.x.text} counted characters (a URL counts as 23).` },
);
const xPostSchema = z
  .object({
    text: xPostTextSchema,
    thread: z.array(xPostTextSchema).min(1).max(X_THREAD_MAX_PARTS).optional(),
  })
  .strict();

const xImagePostSchema = z
  .object({
    text: xPostTextSchema,
    image_path: z
      .string()
      .regex(IMAGE_PATH_RE, "image_path must be an agent-chat-images path (<tenant>/<uuid>.jpg), not a URL"),
  })
  .strict();
const xVideoPostSchema = z
  .object({
    text: xPostTextSchema,
    video_path: z
      .string()
      .regex(VIDEO_PATH_RE, "video_path must be a launch-video-media path (<tenant>/<uuid>.mp4), not a URL"),
  })
  .strict();

const linkedinImagePostSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.linkedin_image.text),
    image_path: z
      .string()
      .regex(IMAGE_PATH_RE, "image_path must be an agent-chat-images path (<tenant>/<uuid>.jpg), not a URL"),
  })
  .strict();

const linkedinVideoPostSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.linkedin_video.text),
    video_path: z
      .string()
      .regex(VIDEO_PATH_RE, "video_path must be a launch-video-media path (<tenant>/<uuid>.mp4), not a URL"),
  })
  .strict();

const instagramVideoPostSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.instagram_video.text),
    video_path: z
      .string()
      .regex(VIDEO_PATH_RE, "video_path must be a launch-video-media path (<tenant>/<uuid>.mp4), not a URL"),
  })
  .strict();

const instagramImagePostSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.instagram_image.text),
    image_path: z
      .string()
      .regex(IMAGE_PATH_RE, "image_path must be an agent-chat-images path (<tenant>/<uuid>.jpg), not a URL"),
  })
  .strict();

const youtubeVideoSchema = z
  .object({
    title: z.string().min(1).max(SOCIAL_LIMITS.youtube_video.title),
    text: z.string().min(1).max(SOCIAL_LIMITS.youtube_video.text),
    video_path: z
      .string()
      .regex(VIDEO_PATH_RE, "video_path must be a launch-video-media path (<tenant>/<uuid>.mp4), not a URL"),
    privacy: z.enum(["public", "unlisted", "private"]).default("public"),
  })
  .strict();

const tiktokVideoSchema = z
  .object({
    text: z.string().min(1).max(SOCIAL_LIMITS.tiktok_video.text),
    video_path: z
      .string()
      .regex(VIDEO_PATH_RE, "video_path must be a launch-video-media path (<tenant>/<uuid>.mp4), not a URL"),
    privacy: z
      .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
      .default("SELF_ONLY"),
  })
  .strict();

const pinterestPinSchema = z
  .object({
    title: z.string().min(1).max(SOCIAL_LIMITS.pinterest_pin.title),
    text: z.string().min(1).max(SOCIAL_LIMITS.pinterest_pin.text),
    image_path: z
      .string()
      .regex(IMAGE_PATH_RE, "image_path must be an agent-chat-images path (<tenant>/<uuid>.jpg), not a URL"),
    board_id: z.string().regex(/^\d{1,30}$/, "board_id must be Pinterest's numeric board id"),
    board_name: z.string().min(1).max(180).optional(),
    link: z
      .string()
      .max(2048)
      .url()
      .refine((u) => u.startsWith("https://"), "link must be an https URL"),
    alt_text: z.string().min(1).max(500).optional(),
  })
  .strict();

export const SOCIAL_CHANNEL_ACTIONS: Record<string, SocialChannelAction> = {
  linkedin: {
    app_slug: "linkedin",
    action_id: "linkedin-create-text-post-user",
    cost: "free",
    enabled: true,
    payload_schema: linkedinPostSchema,
    destination_required: false,
    buildProps: (p) => ({ text: p.text, visibility: "PUBLIC" }),
  },

  linkedin_image: {
    app_slug: "linkedin",
    action_id: "linkedin-create-image-post-user",
    cost: "free",
    enabled: true,
    payload_schema: linkedinImagePostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({
      file: p.image_path,
      text: p.text,
      visibility: "PUBLIC",
    }),
  },

  linkedin_video: {
    app_slug: "linkedin",
    action_id: "linkedin-create-video-post-user",
    cost: "free",
    enabled: true,
    payload_schema: linkedinVideoPostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.video_path, text: p.text }),
  },

  reddit: {
    app_slug: "reddit",
    action_id: "reddit-submit-a-post",
    cost: "free",
    enabled: true,
    payload_schema: redditPostSchema,
    destination_required: false,
    buildProps: (p) => ({
      subreddit: p.subreddit,
      title: p.title,
      kind: "self",
      text: p.text,
    }),
  },

  reddit_comment: {
    app_slug: "reddit",
    action_id: "reddit-post-comment",
    cost: "free",
    enabled: true,
    payload_schema: redditCommentSchema,
    destination_required: false,
    buildProps: (p) => ({ thread_url: p.thread_url, text: p.text }),
  },

  x: {
    app_slug: "twitter",
    action_id: "twitter-create-tweet",
    cost: "paid",
    enabled: true,
    payload_schema: xPostSchema,
    destination_required: false,
    buildProps: (p) => ({
      text: p.text,
      ...(Array.isArray(p.thread) && p.thread.length ? { thread: p.thread } : {}),
    }),
  },

  x_image: {
    app_slug: "twitter",
    action_id: "twitter-create-tweet",
    cost: "paid",
    enabled: true,
    payload_schema: xImagePostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.image_path, text: p.text }),
  },
  x_video: {
    app_slug: "twitter",
    action_id: "twitter-create-tweet",
    cost: "paid",
    enabled: true,
    payload_schema: xVideoPostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.video_path, text: p.text }),
  },

  instagram_image: {
    app_slug: "instagram_business",
    action_id: "instagram_business-create-post",
    cost: "free",
    enabled: true,
    payload_schema: instagramImagePostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.image_path, text: p.text }),
  },

  instagram_video: {
    app_slug: "instagram_business",
    action_id: "instagram_business-create-reel",
    cost: "free",
    enabled: true,
    payload_schema: instagramVideoPostSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.video_path, text: p.text }),
  },

  youtube_video: {
    app_slug: "youtube_data_api",
    action_id: "youtube_data_api-upload-video",
    cost: "free",
    enabled: true,
    payload_schema: youtubeVideoSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.video_path, title: p.title, text: p.text, privacy: p.privacy }),
  },

  tiktok_video: {
    app_slug: "tiktok",
    action_id: "tiktok-upload-video",
    cost: "free",
    enabled: true,
    vendor_review_pending: "TikTok Direct Post audit",
    payload_schema: tiktokVideoSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({ file: p.video_path, text: p.text, privacy: p.privacy }),
  },

  pinterest_pin: {
    app_slug: "pinterest",
    action_id: "pinterest-create-pin",
    cost: "free",
    enabled: true,
    payload_schema: pinterestPinSchema,
    destination_required: false,
    media_prop: "file",
    buildProps: (p) => ({
      file: p.image_path,
      title: p.title,
      text: p.text,
      board_id: p.board_id,
      link: p.link,
      ...(typeof p.alt_text === "string" ? { alt_text: p.alt_text } : {}),
    }),
  },

};

const CHANNEL_PROSE: Record<string, string> = {
  linkedin: "LinkedIn personal profile (text)",
  linkedin_image: "LinkedIn personal profile with an image the operator attached",
  reddit: "Reddit (a text self-post — also needs a subreddit and a title)",
  reddit_comment: "Reddit reply (a comment on one thread — needs the thread URL)",
  x: "X",
  x_image: "X/image (one image the operator attached or the run rendered)",
  x_video: "X/video (one video the operator attached)",
  instagram_image: "Instagram (a caption plus one image the operator attached)",
  instagram_video: "Instagram Reel (a caption plus one video the operator attached)",
  linkedin_video: "LinkedIn personal profile with a video the operator attached",
  youtube_video: "YouTube (an upload of a video the operator attached, with a title)",
  tiktok_video: "TikTok (an upload of a video the operator attached, with a caption)",
  pinterest_pin: "Pinterest (one image pin with a title, description, board and link)",
};

const prose = (slug: string): string => CHANNEL_PROSE[slug] ?? slug;

export function stageableChannelProse(): string {
  return Object.entries(SOCIAL_CHANNEL_ACTIONS)
    .filter(([, a]) => a.enabled)
    .map(([slug]) => prose(slug))
    .join(", ");
}

export function vendorBlockedChannelProse(): string {
  return Object.entries(SOCIAL_CHANNEL_ACTIONS)
    .filter(([, a]) => a.enabled && a.vendor_review_pending)
    .map(([slug, a]) => `${prose(slug)} — awaiting ${a.vendor_review_pending}`)
    .join("; ");
}

export function unavailableChannelProse(): string {
  const off = Object.entries(SOCIAL_CHANNEL_ACTIONS)
    .filter(([, a]) => !a.enabled)
    .map(([slug]) => prose(slug));
  off.push("LinkedIn company pages");
  return off.join(" and ");
}

export function socialChannelAvailabilityLine(): string {
  const vendor = vendorBlockedChannelProse();
  return [
    `- Channels you can STAGE a post for: ${stageableChannelProse()}. ` +
      `${unavailableChannelProse()} are NOT available at all — say so plainly rather than offering them.`,
    `- Staging is not publishing, and publishing is a SEPARATE switch that is off for most accounts. ` +
      `Approving a staged post can still come back with "Social publishing isn't enabled for your account yet." ` +
      `Never promise that approval will put the post online — say it stages for their approval, and that publishing may still be switched off.`,
    ...(vendor
      ? [
          `- Blocked on OUR side, not the operator's: ${vendor}. ` +
            `Do NOT tell them to connect these in Settings as though the tile will work today. ` +
            `When the gap really is ours, say so — that is honest, and "raise it with the Zavi team" is the right answer, not a cop-out.`,
        ]
      : []),
  ].join("\n");
}

export type SocialChannel = keyof typeof SOCIAL_CHANNEL_ACTIONS;

export function resolveChannelAction(channel: string): SocialChannelAction {
  const entry = SOCIAL_CHANNEL_ACTIONS[channel];
  if (!entry) {
    throw new Error(`social-publish: unknown channel "${channel}"`);
  }
  if (!entry.enabled) {
    throw new Error(`social-publish: channel "${channel}" is disabled`);
  }
  return entry;
}

export function validateChannelPayload(
  channel: string,
  raw: unknown,
): SocialPayload {
  const entry = resolveChannelAction(channel);
  return entry.payload_schema.parse(raw) as SocialPayload;
}

export function buildConfiguredProps(
  channel: string,
  validatedPayload: SocialPayload,
  destinationId?: string,
): Record<string, unknown> {
  const entry = resolveChannelAction(channel);
  if (entry.destination_required && !destinationId) {
    throw new Error(
      `social-publish: channel "${channel}" requires a destination id`,
    );
  }
  return entry.buildProps(validatedPayload, destinationId);
}
