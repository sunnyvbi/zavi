
import { createHash } from "node:crypto";
import { xThreadOutcome, type XThreadOutcome } from "@zavi/shared";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { publishInstagramImageViaComposio, publishInstagramVideoViaComposio } from "@/services/connectors/instagram-composio/publish";
import { publishYouTubeVideoViaComposio } from "@/services/connectors/youtube-composio/publish";
import { YOUTUBE_PRIVACY_VALUES, type YouTubePrivacy } from "@/services/connectors/youtube-composio/constants";
import { publishPinterestPinViaComposio } from "@/services/connectors/pinterest-composio/publish";
import { PINTEREST_READINESS_CODES, PUBLISH_RECHECK_MS, resolvePinterestPublishReadiness } from "@/services/connectors/pinterest-composio/readiness";
import { publishRedditCommentViaComposio, publishRedditSelfPostViaComposio } from "@/services/connectors/reddit-composio/publish";
import { resolveChannelAction } from "@/services/connectors/social-channels";
import {
  verifySocialAccountAtPublish,
  type SocialPublishTransport,
} from "@/services/connectors/social-publish-account";
import { socialPublishGate } from "@/services/connectors/social-publish-gate";
import {
  ACCOUNT_CHECK_FAILED,
  ACCOUNT_CHECK_FAILED_MESSAGE,
  checkPublishText,
  MEDIA_LINK_NOT_PUBLIC,
  MEDIA_LINK_NOT_PUBLIC_MESSAGE,
  PUBLISH_REFUSAL_CODES,
} from "@/services/connectors/social-publish-content-guard";
import {
  publishLinkedInImage,
  publishLinkedInVideo,
  publishLinkedInText,
} from "@/services/connectors/linkedin-social/publish";
import { LINKEDIN_SOCIAL_SLUG } from "@/services/connectors/linkedin-social/constants";
import { markConnectorTokenRevoked } from "@/services/connectors/core/token";
import { publishXText, publishXThread, publishXMedia } from "@/services/connectors/x-social/publish";
import { publishRedditComment, publishRedditSelfPost } from "@/services/connectors/reddit-social/publish";
import { publishInstagramImage, publishInstagramVideo } from "@/services/connectors/instagram-social/publish";
import { publishTikTokVideo, TIKTOK_PRIVACY_VALUES, TIKTOK_PRIVATE_ONLY, type TikTokPrivacy } from "@/services/connectors/tiktok/api";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { resolveApprovalPostTarget } from "@/services/slack/approval-post-target";
import { logEvent } from "@/services/logging/logEvent";
import { trackSocialPostPublished } from "@/services/analytics/action-events";
import { refuseIfSocialPostPlanLocked } from "@/routes/approvals/decision-channel";
import { PLAN_UPGRADE_REQUIRED } from "@/services/billing/tiers";

type SocialPostRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  channel: string;
  pipedream_app_slug: string;
  pipedream_action_id: string;
  account_id: string;
  destination_id: string | null;
  configured_props: Record<string, unknown> | null;
  snapshot_hash: string | null;
  scheduled_at: string | null;
  status: string;
  idempotency_key: string;
  transport: SocialPublishTransport;
};

const CLAIMABLE_STATUSES = ["approved", "scheduled"];
const LINKEDIN_POST_CHANNELS = new Set(["linkedin", "linkedin_image", "linkedin_video"]);

const MEDIA_BUCKET = "agent-chat-images";
const VIDEO_BUCKET = "launch-video-media";
const MEDIA_URL_TTL_SECONDS = 300;

class MediaResolveError extends Error {}

export async function resolveMediaProps(
  tenantId: string,
  mediaProp: string,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = props[mediaProp];
  if (typeof path !== "string" || path.length === 0) {
    throw new MediaResolveError(`media prop "${mediaProp}" is missing or not a string`);
  }
  if (/^https?:\/\//i.test(path)) {
    throw new MediaResolveError(`media prop "${mediaProp}" holds a URL; only storage paths are publishable`);
  }
  if (!path.startsWith(`${tenantId}/`)) {
    throw new MediaResolveError(`media path is not owned by tenant ${tenantId}`);
  }
  const bucket = path.endsWith(".mp4") ? VIDEO_BUCKET : MEDIA_BUCKET;
  const { data, error } = await serviceClient()
    .storage.from(bucket)
    .createSignedUrl(path, MEDIA_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new MediaResolveError(`could not sign media path: ${error?.message ?? "no url returned"}`);
  }
  return { ...props, [mediaProp]: data.signedUrl };
}

function pickStr(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function extractIds(
  channel: string,
  raw: unknown,
): { externalPostId: string | null; externalUrl: string | null } {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nestedData = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null;
  const candidates: unknown[] = [
    root,
    root.ret,
    root.data,
    root.body,
    nestedData?.data,
  ].filter((c) => c && typeof c === "object");

  if (channel === "tiktok_video") {
    const ids = root.publicaly_available_post_id ?? root.publicly_available_post_id;
    const postId = Array.isArray(ids) ? ids.map(String).find((id) => id.length > 0) ?? null : null;
    const username = typeof root.creator_username === "string" && root.creator_username ? root.creator_username : null;
    return {
      externalPostId: postId ?? (typeof root.publish_id === "string" && root.publish_id ? root.publish_id : null),
      externalUrl: postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : null,
    };
  }

  let externalPostId: string | null = null;
  for (const c of candidates) {
    externalPostId = pickStr(c, [
      "id",
      "id_str",
      "x-restli-id",
      "activity",
      "urn",
      "shareUrn",
      "postId",
      "uri",
    ]);
    if (externalPostId) break;
  }

  let externalUrl: string | null = null;
  for (const c of candidates) {
    externalUrl = pickStr(c, ["url", "permalink", "permalink_url", "link", "shareUrl"]);
    if (externalUrl) break;
  }

  if (!externalUrl && externalPostId) {
    if (channel === "linkedin" || channel === "linkedin_org" || channel === "linkedin_image" || channel === "linkedin_video") {
      externalUrl = `https://www.linkedin.com/feed/update/${externalPostId}`;
    } else if (channel === "x" || channel === "x_image" || channel === "x_video") {
      externalUrl = `https://x.com/i/web/status/${externalPostId}`;
    }
  }

  return { externalPostId, externalUrl };
}

type RedditTarget = { subreddit: string; title: string } | { thread_url: string };

function redditTarget(channel: string, props: Record<string, unknown>): RedditTarget | null | undefined {
  const str = (k: string) => (typeof props[k] === "string" ? (props[k] as string) : "");
  if (channel === "reddit_comment") return str("thread_url") ? { thread_url: str("thread_url") } : null;
  if (channel === "reddit") return str("subreddit") && str("title") ? { subreddit: str("subreddit"), title: str("title") } : null;
  return undefined;
}

const redditPropsMissing = (channel: string) => ({
  ok: false,
  status: 400,
  raw: { error: `${channel}: frozen props missing ${channel === "reddit_comment" ? "thread_url" : "subreddit or title"}` },
});

export async function publishNative(
  tenantId: string,
  channel: string,
  props: Record<string, unknown>,
): Promise<{ ok: boolean; raw: unknown; status: number }> {
  const text = typeof props.text === "string" ? props.text : "";
  if (channel === "linkedin") {
    return publishLinkedInText(tenantId, text);
  }
  if (channel === "linkedin_image") {
    const url = typeof props.file === "string" ? props.file : "";
    if (!/^https:\/\//.test(url)) {
      return { ok: false, status: 400, raw: { error: "linkedin_image: media prop is not a signed https URL" } };
    }
    return publishLinkedInImage(tenantId, text, url);
  }
  if (channel === "linkedin_video" || channel === "instagram_video") {
    const url = typeof props.file === "string" ? props.file : "";
    if (!/^https:\/\//.test(url)) {
      return { ok: false, status: 400, raw: { error: `${channel}: media prop is not a signed https URL` } };
    }
    return channel === "linkedin_video" ? publishLinkedInVideo(tenantId, text, url) : publishInstagramVideo(tenantId, text, url);
  }
  if (channel === "x") {
    const thread = Array.isArray(props.thread)
      ? (props.thread as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    return thread.length ? publishXThread(tenantId, text, thread) : publishXText(tenantId, text);
  }
  if (channel === "x_image" || channel === "x_video") {
    const url = typeof props.file === "string" ? props.file : "";
    if (!/^https:\/\//.test(url)) {
      return { ok: false, status: 400, raw: { error: `${channel}: media prop is not a signed https URL` } };
    }
    return publishXMedia(tenantId, text, url, channel === "x_image" ? "image" : "video");
  }
  if (channel === "instagram_image") {
    const url = typeof props.file === "string" ? props.file : "";
    if (!/^https:\/\//.test(url)) {
      return { ok: false, status: 400, raw: { error: "instagram_image: media prop is not a signed https URL" } };
    }
    return publishInstagramImage(tenantId, text, url);
  }
  if (channel === "tiktok_video") {
    const url = typeof props.file === "string" ? props.file : "";
    if (!/^https:\/\//.test(url)) {
      return { ok: false, status: 400, raw: { error: "tiktok_video: media prop is not a signed https URL" } };
    }
    const privacy = (TIKTOK_PRIVACY_VALUES as readonly string[]).includes(String(props.privacy))
      ? (props.privacy as TikTokPrivacy)
      : "SELF_ONLY";
    return publishTikTokVideo(tenantId, { caption: text, privacy }, url);
  }
  const target = redditTarget(channel, props);
  if (target === null) return redditPropsMissing(channel);
  if (target) {
    return "thread_url" in target
      ? publishRedditComment(tenantId, target.thread_url, text)
      : publishRedditSelfPost(tenantId, target.subreddit, target.title, text);
  }
  return { ok: false, status: 400, raw: { error: `no native publisher for channel "${channel}"` } };
}

const ACCOUNT_RECHECK_MS = 30_000;

function withinMs<T, F>(work: Promise<T>, ms: number, onTimeout: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function publishComposio(
  row: Pick<SocialPostRow, "tenant_id" | "channel" | "account_id" | "pipedream_app_slug"> & Partial<Pick<SocialPostRow, "configured_props">>,
  props: Record<string, unknown>,
): Promise<{ ok: boolean; raw: unknown; status: number }> {
  const url = typeof props.file === "string" ? props.file : "";
  const text = typeof props.text === "string" ? props.text : "";
  const title = typeof props.title === "string" ? props.title : "";
  const reddit = redditTarget(row.channel, props);
  if (reddit === null) return redditPropsMissing(row.channel);
  if (!reddit && !/^https:\/\//.test(url)) {
    console.warn(`[social-publish] ${row.channel}: signed media URL is not https, nothing sent`);
    return {
      ok: false,
      status: 422,
      raw: { error: MEDIA_LINK_NOT_PUBLIC_MESSAGE, code: MEDIA_LINK_NOT_PUBLIC, message: MEDIA_LINK_NOT_PUBLIC_MESSAGE },
    };
  }
  if (row.channel === "youtube_video" && !title) {
    return { ok: false, status: 400, raw: { error: "youtube_video: frozen props missing title" } };
  }
  if (row.channel === "pinterest_pin") {
    const boardId = typeof props.board_id === "string" ? props.board_id : "";
    const link = typeof props.link === "string" ? props.link : "";
    if (!title || !boardId || !/^https:\/\//.test(link)) {
      return { ok: false, status: 400, raw: { error: "pinterest_pin: frozen props missing title, board_id or https link" } };
    }
  } else if (!reddit && row.channel !== "instagram_image" && row.channel !== "instagram_video" && row.channel !== "youtube_video") {
    return { ok: false, status: 400, raw: { error: `composio transport has no publisher for ${row.channel}` } };
  }
  let owned: Awaited<ReturnType<typeof verifySocialAccountAtPublish>> | "timeout";
  try {
    owned = await withinMs(
      verifySocialAccountAtPublish({
        tenantId: row.tenant_id,
        channel: row.channel,
        accountId: row.account_id,
        pipedreamAppSlug: row.pipedream_app_slug,
        transport: "composio",
      }),
      ACCOUNT_RECHECK_MS,
      "timeout" as const,
    );
  } catch (e) {
    console.warn(`[social-publish] ${row.channel}: account re-check failed: ${(e as Error).message}`);
    owned = "timeout";
  }
  if (owned === "timeout") {
    return {
      ok: false,
      status: 422,
      raw: { error: ACCOUNT_CHECK_FAILED_MESSAGE, code: ACCOUNT_CHECK_FAILED, message: ACCOUNT_CHECK_FAILED_MESSAGE },
    };
  }
  if (typeof owned !== "object") return { ok: false, status: 400, raw: { error: "composio account not re-proven" } };
  if (reddit) {
    return "thread_url" in reddit
      ? publishRedditCommentViaComposio(owned, { thread_url: reddit.thread_url, text })
      : publishRedditSelfPostViaComposio(owned, { ...reddit, text });
  }
  if (row.channel === "instagram_image") return publishInstagramImageViaComposio(owned, text, url);
  if (row.channel === "instagram_video") return publishInstagramVideoViaComposio(owned, text, url);
  if (row.channel === "pinterest_pin") {
    const ready = await resolvePinterestPublishReadiness(
      row.tenant_id,
      { board_id: String(props.board_id), image_path: String(row.configured_props?.file ?? ""), link: String(props.link) },
      { deadlineMs: PUBLISH_RECHECK_MS },
    );
    const blocked = [ready.checks.board, ready.checks.media, ready.checks.link, ready.checks.identity].find((c) => c.status === "fail");
    if (blocked) {
      return { ok: false, status: 422, raw: { error: blocked.reason, code: blocked.reason_code, message: blocked.reason } };
    }
    return publishPinterestPinViaComposio(
      owned,
      {
        board_id: String(props.board_id),
        title,
        description: text,
        link: String(props.link),
        ...(typeof props.alt_text === "string" ? { alt_text: props.alt_text } : {}),
      },
      url,
    );
  }
  const privacy = (YOUTUBE_PRIVACY_VALUES as readonly string[]).includes(String(props.privacy))
    ? (props.privacy as YouTubePrivacy)
    : "public";
  return publishYouTubeVideoViaComposio(owned, { title, description: text, privacy }, url);
}

export const SOCIAL_FAILURE_COPY: Record<string, string> = {
  disconnected:
    "the account is no longer connected. Reconnect it under Toolkit → Integrations and propose the post again.",
  unauthorized_destination: "the connected account can no longer post to that page.",
  vendor_rejected: "the platform rejected it. Open the post in Zavi to see the response.",
  transient_exhausted: "the platform kept timing out, so Zavi could not confirm whether it posted. Check the platform before proposing it again.",
  channel_disabled: "that channel is switched off in Zavi.",
  snapshot_changed: "the post changed after it was approved. Propose it again.",
  reconnect_required: "Reconnect {app} to publish this post.",
};

const CHANNEL_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  linkedin_image: "LinkedIn",
  x: "X",
  x_image: "X",
  x_video: "X",
  tiktok_video: "TikTok",
  reddit: "Reddit",
  reddit_comment: "Reddit",
  instagram_image: "Instagram",
  instagram_video: "Instagram",
  linkedin_video: "LinkedIn",
  youtube_video: "YouTube",
  pinterest_pin: "Pinterest",
};

export function buildSocialResultBody(args: {
  channel: string;
  ok: boolean;
  externalUrl: string | null;
  errorCode: string | null;
  refusal?: string | null;
  partialThread?: XThreadOutcome | null;
}): string {
  const label = CHANNEL_LABEL[args.channel] ?? args.channel.replace(/_/g, " ");
  if (args.ok && args.partialThread) {
    return `${args.partialThread.message}${args.externalUrl ? ` <${args.externalUrl}|Open the thread ↗>` : ""}`;
  }
  if (args.ok) {
    return args.externalUrl
      ? `✅ Posted on ${label} — <${args.externalUrl}|open it ↗>`
      : `✅ Posted on ${label}.`;
  }
  if (args.refusal) return `Couldn't publish the ${label} post. ${args.refusal}`;
  const why = (args.errorCode && SOCIAL_FAILURE_COPY[args.errorCode]?.replace("{app}", label)) || "something went wrong.";
  return `Couldn't publish the ${label} post: ${why}`;
}

export async function notifySocialResult(
  row: Pick<SocialPostRow, "id" | "tenant_id" | "agent_run_id" | "channel">,
  outcome: { ok: boolean; externalUrl: string | null; errorCode: string | null; refusal?: string | null; partialThread?: XThreadOutcome | null },
): Promise<void> {
  try {
    const target = await resolveApprovalPostTarget(row.tenant_id, row.agent_run_id ?? "");
    if (!target) {
      await logEvent({
        level: "info",
        source: "social_publish",
        code: "social_publish.result_no_slack_target",
        tenant_id: row.tenant_id,
        message: "No Slack target for social result; the dashboard row is the surface",
        meta: { post_id: row.id, ok: outcome.ok, code: outcome.errorCode },
      });
      return;
    }
    await enqueueSlackOutbox({
      tenant_id: row.tenant_id,
      channel_id: target.channel,
      team_id: target.team_id ?? null,
      thread_ts: null,
      kind: "social_publish_result",
      body: buildSocialResultBody({ channel: row.channel, ...outcome }),
      run_id: row.agent_run_id ?? null,
      idempotency_key: `social_publish_result:${row.id}`,
      depends_on_answer: false,
    });
  } catch (e) {
    console.warn(`social-publish: result notice failed for ${row.id}: ${(e as Error).message}`);
  }
}

async function finalizeFailed(row: SocialPostRow, code: string): Promise<void> {
  const { error } = await serviceClient().rpc("social_publish_finalize", {
    p_post_id: row.id,
    p_ok: false,
    p_external_post_id: null,
    p_external_url: null,
    p_error: code,
    p_response: null,
  });
  if (error) throw new Error(`social-publish finalizeFailed rpc failed: ${error.message}`);
  if (await failureLanded(row.id)) await notifySocialResult(row, { ok: false, externalUrl: null, errorCode: code });
}

async function failureLanded(postId: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().from("social_posts").select("status").eq("id", postId).maybeSingle();
    if (error) return false;
    return (data as { status?: string } | null)?.status === "failed";
  } catch {
    return false;
  }
}

async function finalizeRefused(row: SocialPostRow, code: string, message: string): Promise<void> {
  const { error } = await serviceClient().rpc("social_publish_finalize", {
    p_post_id: row.id,
    p_ok: false,
    p_external_post_id: null,
    p_external_url: null,
    p_error: "vendor_rejected",
    p_response: { code, error: message },
  });
  if (error) throw new Error(`social-publish finalizeRefused rpc failed: ${error.message}`);
  if (await failureLanded(row.id)) await notifySocialResult(row, { ok: false, externalUrl: null, errorCode: "vendor_rejected", refusal: message });
}

export const socialPublishFn = inngest.createFunction(
  { id: "social-publish", retries: 4 },
  { event: "social/publish.requested" },
  async ({ event, step }) => {
    const postId = event.data.post_id;

    const loaded = await step.run("load-post", async () => {
      const { data, error } = await serviceClient()
        .from("social_posts")
        .select(
          "id, tenant_id, agent_run_id, channel, pipedream_app_slug, pipedream_action_id, account_id, destination_id, configured_props, snapshot_hash, scheduled_at, status, idempotency_key, transport",
        )
        .eq("id", postId)
        .maybeSingle();
      if (error) throw new Error(`social-publish load-post failed: ${error.message}`);
      if (!data) return { found: false as const };
      return { found: true as const, row: data as SocialPostRow };
    });

    if (!loaded.found) return { post_id: postId, status: "missing" };
    const row = loaded.row;
    if (!CLAIMABLE_STATUSES.includes(row.status)) {
      return { post_id: postId, status: "not_claimable", row_status: row.status };
    }

    const tenantId = row.tenant_id;

    if (row.scheduled_at) {
      const when = new Date(row.scheduled_at);
      if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) {
        await step.sleepUntil("wait-for-schedule", when);
      }
    }

    let claimWon = false;
    let finalized = false;
    try {
      const recheck = await step.run("exec-recheck", async () => {
        const sb = serviceClient();

        const gate = await socialPublishGate(sb, tenantId);
        if (!gate.open && gate.error) throw new Error(`social-publish inert-gate rpc failed: ${gate.error}`);
        if (!gate.open) {
          console.warn(
            `social-publish: rail PAUSED (social_publish_enabled = false, or config unreadable) — post ${postId} not published`,
          );
          return { verdict: "inert" as const };
        }

        let action;
        try {
          action = resolveChannelAction(row.channel);
        } catch {
          await finalizeFailed(row, "channel_disabled");
          return { verdict: "failed" as const, code: "channel_disabled" };
        }

        const { data: fresh, error: freshErr } = await sb
          .from("social_posts")
          .select("status, snapshot_hash")
          .eq("id", postId)
          .maybeSingle();
        if (freshErr) throw new Error(`social-publish recheck re-read failed: ${freshErr.message}`);
        const freshRow = fresh as { status?: string; snapshot_hash?: string | null } | null;
        if (!freshRow || !CLAIMABLE_STATUSES.includes(freshRow.status ?? "")) {
          return { verdict: "not_claimable" as const };
        }

        if ((freshRow.snapshot_hash ?? null) !== (row.snapshot_hash ?? null)) {
          await finalizeFailed(row, "snapshot_changed");
          return { verdict: "failed" as const, code: "snapshot_changed" };
        }

        const planRefusal = await refuseIfSocialPostPlanLocked(tenantId, row.channel, { strict: true });
        if (planRefusal) {
          await finalizeRefused(row, PLAN_UPGRADE_REQUIRED, planRefusal.message);
          return { verdict: "failed" as const, code: PLAN_UPGRADE_REQUIRED };
        }

        const owned = await verifySocialAccountAtPublish({
          tenantId,
          channel: row.channel,
          accountId: row.account_id,
          pipedreamAppSlug: row.pipedream_app_slug,
          transport: row.transport,
        });
        if (owned === "reconnect_required") {
          await finalizeFailed(row, "reconnect_required");
          return { verdict: "failed" as const, code: "reconnect_required" };
        }
        if (!owned) {
          await finalizeFailed(row, "disconnected");
          return { verdict: "failed" as const, code: "disconnected" };
        }

        if (action.destination_required) {
          if (!row.destination_id) {
            await finalizeFailed(row, "unauthorized_destination");
            return { verdict: "failed" as const, code: "unauthorized_destination" };
          }
          const { data: dest, error: destErr } = await sb
            .from("social_destinations")
            .select("id, role_verified, destination_id")
            .eq("id", row.destination_id)
            .maybeSingle();
          if (destErr) throw new Error(`social-publish destination re-read failed: ${destErr.message}`);
          const POST_CAPABLE_ROLES = ["ADMIN", "CONTENT"];
          const destRow = dest as { role_verified?: string | null } | null;
          if (
            !destRow ||
            !destRow.role_verified ||
            !POST_CAPABLE_ROLES.includes(destRow.role_verified.toUpperCase())
          ) {
            await finalizeFailed(row, "unauthorized_destination");
            return { verdict: "failed" as const, code: "unauthorized_destination" };
          }
        }

        return { verdict: "proceed" as const };
      });

      if (recheck.verdict === "inert") return { post_id: postId, status: "inert" };
      if (recheck.verdict === "not_claimable") return { post_id: postId, status: "not_claimable" };
      if (recheck.verdict === "failed") return { post_id: postId, status: "failed", error: recheck.code };

      const claim = await step.run("claim", async () => {
        const sb = serviceClient();
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify({
              action_id: row.pipedream_action_id,
              account_id: row.account_id,
              configured_props: row.configured_props ?? {},
            }),
          )
          .digest("hex");
        const { data: won, error: claimErr } = await sb.rpc("social_publish_claim", {
          p_post_id: postId,
          p_idempotency_key: row.idempotency_key,
          p_request_hash: requestHash,
        });
        if (claimErr) throw new Error(`social-publish claim rpc failed: ${claimErr.message}`);
        if (won === true) return { won: true as const };

        let reconciled: "done" | "left" = "left";
        try {
          const { data: attempts } = await sb
            .from("social_publish_attempts")
            .select("status, outcome")
            .eq("idempotency_key", row.idempotency_key);
          const succeeded =
            Array.isArray(attempts) &&
            attempts.some(
              (a) =>
                (a as { status?: string; outcome?: string })?.status === "succeeded" ||
                (a as { status?: string; outcome?: string })?.outcome === "succeeded",
            );
          reconciled = succeeded ? "done" : "left";
        } catch {
        }
        return { won: false as const, reconciled };
      });

      if (!claim.won) {
        return {
          post_id: postId,
          status: claim.reconciled === "done" ? "already_published" : "claimed_by_other",
        };
      }
      claimWon = true;

      const publishResult = await step.run("publish", async () => {
        const { data: maySend, error: beginErr } = await serviceClient().rpc("social_publish_begin_send", {
          p_post_id: postId,
          p_idempotency_key: row.idempotency_key,
        });
        if (beginErr) {
          return {
            ok: false,
            raw: { code: "publish_guard_unavailable", error: beginErr.message },
            status: 0,
          } as const;
        }
        if (maySend !== true) {
          return {
            ok: false,
            raw: {
              code: "publish_outcome_unknown",
              message: "Zavi could not confirm whether the platform already received this post. Check the platform before posting again.",
            },
            status: 0,
          } as const;
        }
        let props = (row.configured_props ?? {}) as Record<string, unknown>;
        try {
          const mediaProp = resolveChannelAction(row.channel).media_prop;
          if (mediaProp) props = await resolveMediaProps(tenantId, mediaProp, props);
        } catch (e) {
          return { ok: false, raw: { error: (e as Error).message }, status: 400 } as const;
        }
        const refused = checkPublishText(props);
        if (refused) {
          return { ok: false, raw: { error: refused.message, ...refused }, status: 422 } as const;
        }
        try {
          if (row.transport === "native") {
            return await publishNative(tenantId, row.channel, props);
          }
          if (row.transport === "composio") {
            return await publishComposio(row, props);
          }
          return { ok: false, status: 400, raw: { error: `no publisher for transport "${row.transport}"` } } as const;
        } catch (e) {
          return { ok: false, raw: { error: (e as Error).message }, status: 0 } as const;
        }
      });

      const final = await step.run("extract-finalize", async () => {
        const { externalPostId, externalUrl } = extractIds(row.channel, publishResult.raw);
        let errorCode: string | null = null;
        if (!publishResult.ok) {
          errorCode =
            publishResult.status >= 500 || publishResult.status === 0 || publishResult.status === 429
              ? "transient_exhausted"
              : publishResult.status === 401 && row.transport === "native" && LINKEDIN_POST_CHANNELS.has(row.channel)
                ? "disconnected"
                : "vendor_rejected";
        }
        const { error: finErr } = await serviceClient().rpc("social_publish_finalize", {
          p_post_id: postId,
          p_ok: publishResult.ok,
          p_external_post_id: externalPostId,
          p_external_url: externalUrl,
          p_error: errorCode,
          p_response: (publishResult.raw ?? null) as Record<string, unknown> | null,
        });
        if (finErr) throw new Error(`social-publish finalize rpc failed: ${finErr.message}`);
        if (errorCode === "disconnected" && LINKEDIN_POST_CHANNELS.has(row.channel)) {
          try {
            await markConnectorTokenRevoked(row.tenant_id, LINKEDIN_SOCIAL_SLUG);
          } catch (e) {
            console.error(`[social-publish] linkedin_social not marked for reconnect: ${(e as Error)?.message ?? e}`);
          }
        }
        if (publishResult.ok) trackSocialPostPublished({ tenant_id: row.tenant_id, platform: row.channel });
        const raw = publishResult.raw as { code?: unknown; message?: unknown } | null;
        const refusal =
          raw &&
          (PUBLISH_REFUSAL_CODES.includes(String(raw.code)) || (PINTEREST_READINESS_CODES as readonly string[]).includes(String(raw.code)) || raw.code === TIKTOK_PRIVATE_ONLY) &&
          typeof raw.message === "string"
            ? raw.message
            : null;
        const tail = row.configured_props?.thread;
        const partialThread = row.channel === "x" && publishResult.ok
          ? xThreadOutcome(publishResult.raw, Array.isArray(tail) ? tail.length + 1 : undefined)
          : null;
        await notifySocialResult(row, { ok: publishResult.ok, externalUrl, errorCode, refusal, partialThread });
        const threadUrl = (row.configured_props as Record<string, unknown> | null)?.thread_url;
        if (publishResult.ok && row.channel === "reddit_comment" && typeof threadUrl === "string") {
          try {
            const [{ markRedditThreadPosted }, { redditDb }] = await Promise.all([
              import("@/services/channels/reddit/thread-posted"),
              import("@/services/channels/reddit/db"),
            ]);
            await markRedditThreadPosted(redditDb(), row.tenant_id, threadUrl);
          } catch (e) {
            console.error(`[social-publish] reddit thread not marked posted: ${(e as Error)?.message ?? e}`);
          }
        }
        return { ok: publishResult.ok, externalPostId, externalUrl, errorCode, partial: partialThread !== null };
      });

      finalized = true;
      if (final.ok && !final.partial) {
        await step.run("close-post-card", async () => {
          const { closePostCardsForPublished } = await import("@/services/channels/post-live");
          return { closed: await closePostCardsForPublished({ id: postId, tenant_id: row.tenant_id, agent_run_id: row.agent_run_id, channel: row.channel, externalUrl: final.externalUrl }) };
        });
      }

      return {
        post_id: postId,
        status: final.ok ? "published" : "failed",
        external_post_id: final.externalPostId,
        error: final.errorCode,
      };
    } catch (err) {
      if (claimWon && !finalized) {
        await step.run("finalize-transient", async () => {
          await finalizeFailed(row, "transient_exhausted");
          return { finalized: true };
        });
      }
      throw err;
    }
  },
);
