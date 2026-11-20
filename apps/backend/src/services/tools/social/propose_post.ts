
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { resolvePinterestPublishReadiness, type PinterestReadiness } from "@/services/connectors/pinterest-composio/readiness";
import { LOOKBACK_WINDOW_MINUTES } from "@/services/agents/a2a-attachment-forwarding";
import { channelDisplayName } from "@zavi/shared";
import { socialPublishPausedState } from "@/agents/social/social-publish-flag";
import {
  IMAGE_PATH_RE,
  VIDEO_PATH_RE,
  resolveChannelAction,
  validateChannelPayload,
  xPostTextSchema,
  X_THREAD_MAX_PARTS,
} from "@/services/connectors/social-channels";

export const SOCIAL_PUBLISH_CLASS = "social.publish.v2";

const MEDIA_GATES: Record<string, { key: "image_path" | "video_path"; re: RegExp }> = {
  linkedin_image: { key: "image_path", re: IMAGE_PATH_RE },
  x_image: { key: "image_path", re: IMAGE_PATH_RE },
  x_video: { key: "video_path", re: VIDEO_PATH_RE },
  linkedin_video: { key: "video_path", re: VIDEO_PATH_RE },
  instagram_video: { key: "video_path", re: VIDEO_PATH_RE },
  instagram_image: { key: "image_path", re: IMAGE_PATH_RE },
  youtube_video: { key: "video_path", re: VIDEO_PATH_RE },
  tiktok_video: { key: "video_path", re: VIDEO_PATH_RE },
  pinterest_pin: { key: "image_path", re: IMAGE_PATH_RE },
};

const inputSchema = z.object({
  channel: z
    .enum(["linkedin", "linkedin_image", "linkedin_video", "x", "x_image", "x_video", "instagram_image", "instagram_video", "reddit", "reddit_comment", "youtube_video", "tiktok_video", "pinterest_pin"])
    .describe(
      "Where to post. `linkedin` = text on the operator's personal profile; `linkedin_image` = text + one image they attached (needs image_path); `x` = a text post on the operator's X account (280 chars; a THREAD is one call — root in `text`, tail parts in `thread`); `x_image` = an X post with one image (needs image_path — an upload from this conversation or a report__render_social_image result); `x_video` = an X post with one video the operator uploaded (needs video_path); `instagram_image` = caption + one attached image (needs image_path); `reddit` = a text self-post (needs subreddit + title); `reddit_comment` = a reply on one Reddit thread (needs thread_url); `youtube_video` = upload an attached video (needs video_path + title; text is the description); `pinterest_pin` = one image pin (needs image_path + title + board_id + link; text is the description).",
    ),
  text: z
    .string()
    .min(1)
    .max(40_000)
    .describe("The finished post copy, ready to publish as-is. LinkedIn caps at 3000 characters. For an X thread this is the ROOT post."),
  thread: z
    .array(xPostTextSchema)
    .min(1)
    .max(X_THREAD_MAX_PARTS)
    .optional()
    .describe(
      "x ONLY. The thread's tail: 1-4 parts after the root, each ≤280 as X counts (a URL is 23, an emoji 2), posted in order as replies under the root. One approval card covers the whole thread. Omit for a single post.",
    ),
  image_path: z
    .string()
    .optional()
    .describe(
      "linkedin_image / instagram_image / x_image / pinterest_pin ONLY. The agent-chat-images storage path of an image the operator uploaded this conversation (shape `<tenant_uuid>/<file_uuid>.jpg`). Never a URL.",
    ),
  video_path: z
    .string()
    .optional()
    .describe(
      "youtube_video / x_video / tiktok_video / instagram_video / linkedin_video ONLY. The storage path of a video the operator uploaded this conversation (shape `<tenant_uuid>/<file_uuid>.mp4`). Never a URL.",
    ),
  privacy: z
    .enum(["public", "unlisted", "private"])
    .optional()
    .describe("youtube_video ONLY. Defaults to public."),
  tiktok_privacy: z
    .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
    .optional()
    .describe(
      "tiktok_video ONLY. TikTok's own levels — deliberately not YouTube's `privacy`, which has no equivalent for MUTUAL_FOLLOW_FRIENDS or FOLLOWER_OF_CREATOR. Defaults SELF_ONLY, and until TikTok audits Direct Post it forces every API post private regardless. Call tiktok__get_creator_info first: it returns the levels this account may actually use right now.",
    ),
  subreddit: z
    .string()
    .optional()
    .describe("reddit ONLY. Bare subreddit display name, no `r/` prefix."),
  thread_url: z.string().optional().describe("reddit_comment ONLY. The reddit.com/r/<sub>/comments/<id> link of the thread to reply on."),
  title: z.string().max(300).optional().describe("reddit + youtube_video + pinterest_pin. Post/video/pin title (Reddit ≤300 chars, YouTube and Pinterest ≤100)."),
  board_id: z.string().optional().describe("pinterest_pin ONLY. Numeric id of one of THEIR boards, from pinterest_insights__read."),
  board_name: z.string().optional().describe("pinterest_pin ONLY. Optional; the card always shows the account's own name for board_id."),
  link: z.string().optional().describe("pinterest_pin ONLY. The https page the pin sends shoppers to (a product or category page read this run)."),
  alt_text: z.string().optional().describe("pinterest_pin ONLY. What the image shows, ≤500 chars."),
  rationale: z
    .string()
    .min(1)
    .max(500)
    .describe("ONE sentence on why this post, now — shown to the operator on the approval card."),
  scheduled_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "Optional ISO-8601 time to publish (e.g. 2026-09-12T09:00:00Z). Omit to publish as soon as the operator approves.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export function buildProposePayload(input: Input): Record<string, unknown> {
  switch (input.channel) {
    case "linkedin":
      return { text: input.text };
    case "x":
      return {
        text: input.text,
        ...(input.thread && input.thread.length ? { thread: input.thread } : {}),
      };
    case "linkedin_image":
    case "instagram_image":
    case "x_image":
      return { text: input.text, image_path: input.image_path };
    case "x_video":
    case "linkedin_video":
    case "instagram_video":
      return { text: input.text, video_path: input.video_path };
    case "reddit":
      return { subreddit: input.subreddit, title: input.title, text: input.text };
    case "reddit_comment":
      return { thread_url: input.thread_url, text: input.text };
    case "youtube_video":
      return {
        title: input.title,
        text: input.text,
        video_path: input.video_path,
        ...(input.privacy ? { privacy: input.privacy } : {}),
      };
    case "tiktok_video":
      return {
        text: input.text,
        video_path: input.video_path,
        ...(input.tiktok_privacy ? { privacy: input.tiktok_privacy } : {}),
      };
    case "pinterest_pin":
      return {
        title: input.title,
        text: input.text,
        image_path: input.image_path,
        board_id: input.board_id,
        link: input.link,
        ...(input.board_name ? { board_name: input.board_name } : {}),
        ...(input.alt_text ? { alt_text: input.alt_text } : {}),
      };
  }
}

export const socialProposePostTool: ToolSpec = {
  name: "social_propose_post",
  effect: "write",
  description:
    "Stage a social post for the operator's approval. Publishes NOTHING — it creates an approval card; the operator's click is what publishes. Use it when a run has produced finished copy that should ship. Channels: linkedin (text), linkedin_image (text + an operator-uploaded image), x (text post, 280 chars; a thread is ONE card: root in text, 1–4 tail parts in thread), instagram_image (caption + an operator-uploaded image), reddit (text self-post), reddit_comment (a reply on one thread), youtube_video (an operator-uploaded video + title), tiktok_video (an operator-uploaded video + caption), pinterest_pin (a rendered or uploaded image + title + description + board + link). Do not call it for LinkedIn company pages — not available.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "social_propose_no_emit",
        "Cannot stage a post in this context — the runner did not plumb emit_decision.",
      );
    }
    const input = inputSchema.parse(rawInput);

    if (input.thread && input.thread.length > 0 && input.channel !== "x") {
      throw new ExpectedToolError(
        "social_propose_invalid_payload",
        "`thread` is x ONLY; other channels take a single `text`.",
      );
    }

    try {
      resolveChannelAction(input.channel);
    } catch (e) {
      throw new ExpectedToolError("social_propose_channel_unavailable", (e as Error).message);
    }

    const gate = MEDIA_GATES[input.channel];
    if (gate) {
      const p = input[gate.key] ?? "";
      if (!p.startsWith(`${ctx.tenant_id}/`) || !gate.re.test(p)) {
        throw new ExpectedToolError(
          "social_propose_image_not_owned",
          `${gate.key} must be a storage path the operator uploaded in this workspace (not a URL). ` +
            `A local/temp file path means the upload is no longer available to this run — ` +
            `do not retry with another path; ask the user, in one line, to re-attach the file ` +
            `and send the request again (uploads stay available for ${LOOKBACK_WINDOW_MINUTES} minutes). Say nothing more about why.`,
        );
      }
    }

    const payload = buildProposePayload(input);
    let validated: Record<string, unknown>;
    try {
      validated = validateChannelPayload(input.channel, payload) as Record<string, unknown>;
    } catch (e) {
      throw new ExpectedToolError(
        "social_propose_invalid_payload",
        (e as Error).message.slice(0, 500),
      );
    }

    let readiness: PinterestReadiness | null = null;
    if (input.channel === "pinterest_pin") {
      readiness = await resolvePinterestPublishReadiness(ctx.tenant_id, {
        board_id: String(validated.board_id),
        image_path: String(validated.image_path),
        link: String(validated.link),
      });
      if (!readiness.ok || !readiness.board) {
        throw new ExpectedToolError(
          "social_propose_pinterest_not_ready",
          `${readiness.reason ?? "The Pinterest board could not be confirmed."}${readiness.checks.board.status === "pass" ? "" : " Read pinterest_insights__read for the board ids."} Tell the founder this in one line.`,
          { reason_code: readiness.reason_code ?? "pinterest_lookup_failed" },
        );
      }
      validated = { ...validated, board_name: readiness.board.name };
    }

    const decision_id = await ctx.emit_decision(SOCIAL_PUBLISH_CLASS, {
      channel: input.channel,
      payload: validated,
      scheduled_at: input.scheduled_at ?? null,
      rationale: input.rationale,
      origin: "agent_social_tool",
      ...(readiness ? { readiness } : {}),
    });

    const { SOCIAL_ACTION_CHANNEL_SLUG } = await import("@/routes/approvals/decision-channel");
    const page = channelDisplayName(SOCIAL_ACTION_CHANNEL_SLUG[input.channel] ?? input.channel);
    const paused = await socialPublishPausedState(ctx.tenant_id);
    return {
      decision_id,
      decision_class: SOCIAL_PUBLISH_CLASS,
      channel: input.channel,
      staged: true,
      published: false,
      ...(paused === undefined ? {} : { publishing_paused: paused }),
      note: `Staged for approval. Nothing is live until the operator approves the card on the ${page} channel page (Growth Channels → ${page}).`,
    };
  },
};
