import crypto from "node:crypto";
import { checkPublishText } from "@/services/connectors/social-publish-content-guard";
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  fetchTikTokPostStatus,
  initTikTokDraft,
  queryAccountStats,
  queryCreatorInfo,
  sendTikTokVideoToInbox,
  tiktokApi,
  TIKTOK_VIDEO_LIST_FIELDS,
  TIKTOK_VIDEO_PATH_RE,
} from "@/services/connectors/tiktok/api";

const privacy = z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
const mediaType = z.enum(["VIDEO", "PHOTO"]);
const videoPath = z
  .string()
  .regex(TIKTOK_VIDEO_PATH_RE, "video_path must be <tenant-id>/<uuid>.mp4");
const createSchema = z.object({
  media_type: mediaType.default("VIDEO"),
  video_path: videoPath.optional(),
  photo_urls: z.array(z.string().url()).optional(),
  title: z.string().max(2200).default(""),
  description: z.string().max(2200).default(""),
  privacy_level: privacy,
  disable_comment: z.boolean().default(false),
  disable_duet: z.boolean().default(false),
  disable_stitch: z.boolean().default(false),
  auto_add_music: z.boolean().default(false),
  confirm_user_consent: z.boolean(),
});

const scheduledSchema = createSchema.extend({
  scheduled_at: z.string().datetime(),
  timezone: z.string().min(1).default("UTC"),
});

function validateMedia(input: z.infer<typeof createSchema>) {
  if (input.media_type === "VIDEO" && !input.video_path) {
    throw new ExpectedToolError("tiktok_video_path_required", "video_path is required for a VIDEO post. Upload the video through chat first.");
  }
  if (input.media_type === "PHOTO" && (!input.photo_urls || input.photo_urls.length === 0)) {
    throw new ExpectedToolError("tiktok_photo_urls_required", "At least one photo URL is required for a PHOTO post.");
  }
  if (!input.confirm_user_consent) {
    throw new ExpectedToolError("tiktok_consent_required", "The creator must explicitly approve this post and its settings before it can be scheduled.");
  }
}

const HUMAN_ACTOR_SOURCES = new Set(["chat", "slack", "approval"]);
const INTERACTIVE_TRIGGERS = new Set(["chat", "slack", "manual"]);

function assertInteractiveConsent(ctx: {
  run_trigger?: string;
  actor?: { actor_source?: string };
}) {
  const source = ctx.actor?.actor_source;
  if (source && HUMAN_ACTOR_SOURCES.has(source)) return;
  if (!source && ctx.run_trigger && INTERACTIVE_TRIGGERS.has(ctx.run_trigger)) return;
  throw new ExpectedToolError(
    "tiktok_interactive_consent_required",
    "Queueing, editing or cancelling a TikTok post needs a person behind the request — ask the operator for it, or say it in chat or Slack. A scheduled or autonomous run can read the account and recommend, but never publish.",
  );
}

function assertCopyReady(input: { title?: unknown; description?: unknown }): void {
  const refused = checkPublishText({ title: input.title, description: input.description });
  if (refused) throw new ExpectedToolError(refused.code, refused.message);
}

function assertVideoOwned(tenantId: string, input: z.infer<typeof createSchema>): void {
  if (input.media_type === "VIDEO" && !input.video_path?.startsWith(`${tenantId}/`)) {
    throw new ExpectedToolError("tiktok_video_path_foreign", "video_path is not owned by this workspace.");
  }
}

async function createScheduled(tenant_id: string, input: z.infer<typeof createSchema>, scheduledAt: string, timezone: string) {
  validateMedia(input);
  assertCopyReady(input);
  assertVideoOwned(tenant_id, input);
  const creator = await queryCreatorInfo(tenant_id);
  const allowed = creator?.data?.privacy_level_options as string[] | undefined;
  if (allowed && !allowed.includes(input.privacy_level)) {
    throw new ExpectedToolError("tiktok_privacy_not_allowed", `Creator does not currently allow ${input.privacy_level}. Allowed: ${allowed.join(", ")}`);
  }
  const content = {
    media_type: input.media_type,
    video_path: input.video_path ?? null,
    photo_urls: input.photo_urls ?? null,
    title: input.title,
    description: input.description,
    privacy_level: input.privacy_level,
    disable_comment: input.disable_comment,
    disable_duet: input.disable_duet,
    disable_stitch: input.disable_stitch,
    auto_add_music: input.auto_add_music,
  };
  const idempotency = crypto.createHash("sha256").update(JSON.stringify({ tenant_id, scheduledAt, content })).digest("hex");
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tiktok_scheduled_posts").insert({
    scheduled_at: scheduledAt, timezone, content,
    status: "scheduled", idempotency_key: idempotency,
  }).select("id, scheduled_at, status").single();
  if (error) {
    if (error.code === "23505") throw new ExpectedToolError("tiktok_duplicate_schedule", "This exact TikTok post is already scheduled.");
    throw new Error(`TikTok schedule insert failed: ${error.message}`);
  }
  return data;
}

export const tiktokGetCreatorInfoTool: ToolSpec = {
  name: "tiktok_get_creator_info", description: "Get the connected TikTok creator's current identity, allowed privacy choices, interaction settings, and maximum video duration. Read-only; call before preparing a post.",
  effect: "read",
  input_schema: z.object({}), async execute(ctx) { return queryCreatorInfo(ctx.tenant_id); },
};

export const tiktokGetAccountStatsTool: ToolSpec = {
  name: "tiktok_get_account_stats", description: "Get the connected TikTok account's current totals from TikTok's own API: follower_count, likes_count (likes received across all its videos) and video_count. A point-in-time snapshot with no history, so it cannot show follower growth over time. A null count is unknown, not zero. Read-only. tiktok_scope_missing means the account must reconnect TikTok to grant the permission.",
  effect: "read",
  input_schema: z.object({}), async execute(ctx) { return queryAccountStats(ctx.tenant_id); },
};

export const tiktokListVideosTool: ToolSpec = {
  name: "tiktok_list_videos", description: "List the connected creator's recent public TikTok videos and organic engagement metrics. Read-only.",
  effect: "read",
  input_schema: z.object({ max_count: z.number().int().min(1).max(20).default(20), cursor: z.number().int().optional() }),
  async execute(ctx, raw) {
    const input = this.input_schema.parse(raw) as { max_count: number; cursor?: number };
    return tiktokApi(ctx.tenant_id, `/v2/video/list/?fields=${TIKTOK_VIDEO_LIST_FIELDS}`, input);
  },
};

export const tiktokCreatePostTool: ToolSpec = {
  name: "tiktok_create_post", description: "Queue an approved TikTok video or photo post for immediate publishing. Requires explicit creator consent; returns an internal job receipt and never silently changes TikTok privacy settings.",
  effect: "write",
  input_schema: createSchema,
  async execute(ctx, raw) { assertInteractiveConsent(ctx); const input = createSchema.parse(raw); return createScheduled(ctx.tenant_id, input, new Date().toISOString(), "UTC"); },
};

export const tiktokSchedulePostTool: ToolSpec = {
  name: "tiktok_schedule_post", description: "Schedule an explicitly approved TikTok video or photo post. Videos use a workspace-owned video_path; photo URLs must use a domain or URL prefix verified in TikTok Developer Portal.",
  effect: "write",
  input_schema: scheduledSchema,
  async execute(ctx, raw) {
    assertInteractiveConsent(ctx);
    const input = scheduledSchema.parse(raw);
    if (new Date(input.scheduled_at).getTime() < Date.now() + 60_000) throw new ExpectedToolError("tiktok_schedule_too_soon", "scheduled_at must be at least one minute in the future; use create_post for immediate publishing.");
    return createScheduled(ctx.tenant_id, input, input.scheduled_at, input.timezone);
  },
};

export const tiktokListScheduledPostsTool: ToolSpec = {
  name: "tiktok_list_scheduled_posts", description: "List this workspace's TikTok publishing jobs, including scheduled, processing, published, failed, and cancelled posts.",
  effect: "read",
  input_schema: z.object({ status: z.enum(["scheduled", "publishing", "processing", "published", "failed", "cancelled", "all"]).default("all"), limit: z.number().int().min(1).max(100).default(50) }),
  async execute(ctx, raw) {
    const input = this.input_schema.parse(raw) as { status: string; limit: number };
    let q = tenantClient(asTenantId(ctx.tenant_id)).from("tiktok_scheduled_posts").select("id, scheduled_at, timezone, content, status, publish_id, external_post_ids, failure_reason, created_at, updated_at").order("scheduled_at", { ascending: true }).limit(input.limit);
    if (input.status !== "all") q = q.eq("status", input.status);
    const { data, error } = await q; if (error) throw new Error(error.message); return { posts: data ?? [] };
  },
};

export const tiktokUpdateScheduledPostTool: ToolSpec = {
  name: "tiktok_update_scheduled_post", description: "Update the time or approved content of a TikTok job that has not started publishing. Explicit creator consent is required again for content changes.",
  effect: "write",
  input_schema: scheduledSchema.extend({ post_id: z.string().uuid() }),
  async execute(ctx, raw) {
    assertInteractiveConsent(ctx);
    const input = this.input_schema.parse(raw) as z.infer<typeof scheduledSchema> & { post_id: string }; validateMedia(input); assertCopyReady(input); assertVideoOwned(ctx.tenant_id, input);
    if (new Date(input.scheduled_at).getTime() < Date.now() + 60_000) throw new ExpectedToolError("tiktok_schedule_too_soon", "scheduled_at must be at least one minute in the future.");
    const content = { media_type: input.media_type, video_path: input.video_path ?? null, photo_urls: input.photo_urls ?? null, title: input.title, description: input.description, privacy_level: input.privacy_level, disable_comment: input.disable_comment, disable_duet: input.disable_duet, disable_stitch: input.disable_stitch, auto_add_music: input.auto_add_music };
    const idempotency_key = crypto.createHash("sha256").update(JSON.stringify({ tenant_id: ctx.tenant_id, scheduledAt: input.scheduled_at, content })).digest("hex");
    const { data, error } = await tenantClient(asTenantId(ctx.tenant_id)).from("tiktok_scheduled_posts").update({ scheduled_at: input.scheduled_at, timezone: input.timezone, content, idempotency_key, updated_at: new Date().toISOString() }).eq("id", input.post_id).eq("status", "scheduled").select("id, scheduled_at, status").maybeSingle();
    if (error) throw new Error(error.message); if (!data) throw new ExpectedToolError("tiktok_post_not_editable", "Post was not found in this workspace or has already started publishing."); return data;
  },
};

export const tiktokCancelScheduledPostTool: ToolSpec = {
  name: "tiktok_cancel_scheduled_post", description: "Cancel a TikTok post that has not started publishing.",
  effect: "write",
  input_schema: z.object({ post_id: z.string().uuid() }),
  async execute(ctx, raw) { assertInteractiveConsent(ctx); const { post_id } = this.input_schema.parse(raw) as { post_id: string }; const { data, error } = await tenantClient(asTenantId(ctx.tenant_id)).from("tiktok_scheduled_posts").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", post_id).eq("status", "scheduled").select("id, status").maybeSingle(); if (error) throw new Error(error.message); if (!data) throw new ExpectedToolError("tiktok_post_not_cancellable", "Post was not found or is already being published."); return data; },
};

export const tiktokGetPostStatusTool: ToolSpec = {
  name: "tiktok_get_post_status", description: "Fetch live processing/moderation status for a TikTok publish job and persist the latest result.",
  effect: "read",
  input_schema: z.object({ post_id: z.string().uuid() }),
  async execute(ctx, raw) {
    const { post_id } = this.input_schema.parse(raw) as { post_id: string };
    const { data: row } = await tenantClient(asTenantId(ctx.tenant_id)).from("tiktok_scheduled_posts").select("publish_id").eq("id", post_id).maybeSingle();
    const publishId = (row as { publish_id?: string } | null)?.publish_id; if (!publishId) throw new ExpectedToolError("tiktok_publish_not_started", "This job has not been submitted to TikTok yet.");
    const result = await fetchTikTokPostStatus(ctx.tenant_id, publishId); const status = result?.data?.status;
    const mapped = status === "PUBLISH_COMPLETE" ? "published" : status === "FAILED" ? "failed" : "processing";
    if (ctx.writes_suppressed) return result;
    const { error } = await tenantClient(asTenantId(ctx.tenant_id)).from("tiktok_scheduled_posts").update({ status: mapped, external_post_ids: result?.data?.publicly_available_post_id ?? result?.data?.publicaly_available_post_id ?? [], failure_reason: result?.data?.fail_reason ?? null, updated_at: new Date().toISOString() }).eq("id", post_id);
    if (error) throw new Error(`TikTok status persist failed: ${error.message}`);
    return result;
  },
};

export const tiktokUploadDraftTool: ToolSpec = {
  name: "tiktok_upload_draft", description: "Upload an explicitly approved video or photo draft to the creator's TikTok inbox for final editing and manual posting. Video is pushed from workspace storage (video_path); photos are pulled by TikTok and so need a URL on a domain verified in TikTok Developer Portal.",
  effect: "write",
  input_schema: z.object({ media_type: mediaType.default("VIDEO"), video_path: videoPath.optional(), photo_urls: z.array(z.string().url()).optional(), title: z.string().max(90).default(""), description: z.string().max(2200).default(""), confirm_user_consent: z.boolean() }),
  async execute(ctx, raw) {
    assertInteractiveConsent(ctx);
    const input = this.input_schema.parse(raw) as any; validateMedia({ ...input, privacy_level: "SELF_ONLY", disable_comment: false, disable_duet: false, disable_stitch: false, auto_add_music: false });
    if (input.media_type === "VIDEO") return sendTikTokVideoToInbox(ctx.tenant_id, input.video_path);
    return initTikTokDraft(ctx.tenant_id, "PHOTO", {
      post_info: { title: input.title, description: input.description },
      source_info: { source: "PULL_FROM_URL", photo_images: input.photo_urls, photo_cover_index: 0 },
      post_mode: "MEDIA_UPLOAD",
      media_type: "PHOTO",
    });
  },
};

export const tiktokAnalyzeContentTool: ToolSpec = {
  name: "tiktok_analyze_content", description: "Analyze the connected creator's recent TikTok videos using live public engagement metrics; returns ranked posts, engagement rates, and reusable content-pattern evidence. Read-only.",
  effect: "read",
  input_schema: z.object({ max_count: z.number().int().min(3).max(20).default(20) }),
  async execute(ctx, raw) {
    const { max_count } = this.input_schema.parse(raw) as { max_count: number };
    const result: any = await tiktokApi(ctx.tenant_id, "/v2/video/list/?fields=id,title,video_description,duration,create_time,share_url,view_count,like_count,comment_count,share_count", { max_count });
    const videos = (result?.data?.videos ?? []).map((v: any) => { const interactions = Number(v.like_count || 0) + Number(v.comment_count || 0) + Number(v.share_count || 0); const views = Number(v.view_count || 0); return { ...v, interactions, engagement_rate: views ? interactions / views : 0 }; }).sort((a: any, b: any) => b.engagement_rate - a.engagement_rate);
    const totals = videos.reduce((a: any, v: any) => ({ views: a.views + Number(v.view_count || 0), interactions: a.interactions + v.interactions }), { views: 0, interactions: 0 });
    return { sample_size: videos.length, totals, weighted_engagement_rate: totals.views ? totals.interactions / totals.views : 0, top_posts: videos.slice(0, 5), methodology: "(likes + comments + shares) / views; based only on live videos returned by TikTok" };
  },
};

export const TIKTOK_TOOLS = [tiktokGetCreatorInfoTool, tiktokGetAccountStatsTool, tiktokListVideosTool, tiktokCreatePostTool, tiktokSchedulePostTool, tiktokListScheduledPostsTool, tiktokUpdateScheduledPostTool, tiktokCancelScheduledPostTool, tiktokGetPostStatusTool, tiktokUploadDraftTool, tiktokAnalyzeContentTool];
