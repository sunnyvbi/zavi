import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import type { XDraft } from "./xDraftTypes";
import { xDraftToView } from "./cardViews";

export function pairedPostCard(action: ChannelActionView, draft: XDraft): ChannelActionView {
  const post = xDraftToView(draft, action.channel_slug);
  const body = { ...action.body };
  delete body.media;
  delete body.thread;
  const deliverable = { ...body.step?.deliverable, ...post.body.step?.deliverable };
  delete deliverable.parts;
  return {
    ...action,
    action_type: action.action_type === "reply" ? "reply" : post.action_type,
    staged_draft_id: draft.decision_id,
    post_revision: draft.post_revision,
    edited_body: post.edited_body,
    body: {
      ...body,
      ...(post.body.media ? { media: post.body.media } : {}),
      ...(post.body.thread ? { thread: post.body.thread } : {}),
      step: {
        ...body.step,
        deliverable,
      },
    },
  };
}
