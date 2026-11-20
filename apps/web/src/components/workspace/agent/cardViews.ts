
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import type { ActionType } from "@/lib/workspace/actionTypes";
import type { XAttention, XDraft } from "./XAgentDashboard";

export function base(
  id: string,
  channel_slug: string,
  action_type: ActionType,
  title: string,
  proposed_at: string,
): Omit<ChannelActionView, "body"> {
  return {
    id,
    channel_slug,
    run_id: null,
    position: 0,
    run_of: 0,
    blocking: false,
    action_type,
    title,
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 0,
    score_inputs: {},
    proposed_at,
    repeat_of: null,
    redo_of: null,
    source: "channel_action",
    executable: false,
    exec_status: null,
    edited_body: null,
  };
}

export function xDraftToView(draft: XDraft, channel_slug = "x_organic"): ChannelActionView {
  const type: ActionType = draft.image_path ? "image_post" : draft.video_path ? "video_post" : "text_post";
  const image = draft.original_image_path !== undefined ? draft.original_image_path : draft.image_path;
  const thread = draft.original_thread !== undefined ? draft.original_thread : draft.thread;
  const media = image
    ? { kind: "image" as const, url: image }
    : draft.video_path
      ? { kind: "video" as const, url: draft.video_path }
      : null;
  return {
    ...base(
      draft.decision_id,
      channel_slug,
      type,
      draft.label ?? "Post this",
      draft.scheduled_at ?? draft.emitted_at ?? "",
    ),
    edited_body: draft.edited_body ?? null,
    post_revision: draft.post_revision,
    body: {
      step: {
        title: draft.label ?? undefined,
        body: draft.rationale ?? undefined,
        effort: "minutes",
        deliverable: { kind: "post", label: "Post", content: draft.original_text ?? draft.text },
      },
      ...(thread?.length ? { thread } : {}),
      ...(media ? { media } : {}),
    },
  };
}

export const CHECK_CARD_PREFIX = "check:";

export function xCheckToView(a: XAttention, channel_slug = "x_organic"): ChannelActionView {
  return {
    ...base(`${CHECK_CARD_PREFIX}${a.key}`, channel_slug, "fix", a.title, ""),
    blocking: a.blocking,
    body: {
      ...(a.link ? { link: a.link } : {}),
      intent: "fix_setup",
      step: { title: a.title, body: a.detail, effort: "minutes" },
    },
  };
}

export function xDraftsToViews(drafts: XDraft[]): ChannelActionView[] {
  return drafts.map((d) => xDraftToView(d));
}

