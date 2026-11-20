
import { X_THREAD_MAX_PARTS } from "@zavi/shared";
import { xIntentUrl, xLength } from "./_shared";
import { xStagedCards } from "../../agent/xTables";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { POST_APPROVAL, POST_IMAGE, TOPIC, postTextOrZavi } from "../topActions/fieldSets";
import { Activity, Eye, Heart, Link2, MessageSquare, Repeat2, UserPlus, Users } from "lucide-react";

const X_METRICS: Record<string, MetricDisplay> = {
  impressions: { label: "Impressions", icon: Eye },
  engagement_rate: { label: "Engagement rate", icon: Activity },
  profile_visits: { label: "Profile visits", icon: Users },
  link_clicks: { label: "Link clicks", icon: Link2 },
  new_follows: { label: "New follows", icon: UserPlus },
  replies: { label: "Replies", icon: MessageSquare },
  likes: { label: "Likes", icon: Heart },
  reposts: { label: "Reposts", icon: Repeat2 },
};

export const x_organic: PlatformSpec = {
  name: "X",
  accountFromPayload: payload => {
    const d = payload as { connected?: unknown; account_handle?: unknown; account_name?: unknown } | null;
    if (d?.connected !== true || typeof d.account_handle !== "string" || !d.account_handle.trim()) return undefined;
    const handle = `@${d.account_handle.trim().replace(/^@/, "")}`;
    return { name: typeof d.account_name === "string" && d.account_name.trim() ? d.account_name.trim() : handle, handle };
  },
  createMenu: "Create post",
  topActions: [
    {
      key: "new_post",
      label: "New post",
      modal: "form",
      lead: "Zavi writes one post in your voice. Nothing posts until you press Post on it.",
      fields: [TOPIC],
      primary: "Write the post",
      done: "Zavi is writing your post. It will appear in What Zavi wants to do when ready. Nothing publishes until you press Post.",
    },
    {
      key: "new_thread",
      label: "New thread",
      modal: "form",
      lead: "A thread of 3 to 5 posts, ready to post from its card or to paste.",
      fields: [{ kind: "text", name: "topic", label: "Topic", max: 200, error: "Say what the thread is about." }],
      primary: "Write the thread",
      done: "Zavi is writing your thread. It will appear in What Zavi wants to do when ready. Nothing publishes until you press Post.",
    },
    {
      key: "post_image",
      label: "Post with image",
      modal: "form",
      submit: "social_propose",
      socialChannel: "x_image",
      lead: "Add an image. Write the post, or leave it empty and Zavi writes it. You approve it before it posts.",
      note: POST_APPROVAL,
      fields: [POST_IMAGE, postTextOrZavi("Post", 280, xLength)],
      primary: "Send for approval",
      done: "Post waiting for your approval on this page. It posts to X when you approve.",
      writes: {
        key: "post_image_write",
        done: "Zavi is writing the post. It waits for your approval on this page in a minute or two. Nothing posts until you approve it.",
      },
    },
  ],
  description: "Writes your posts and, once connected, publishes the best ones on approval",
  charLimit: 280,
  maxThreadPosts: X_THREAD_MAX_PARTS + 1,
  measure: xLength,
  composerUrl: (text, a) => (a.action_type === "reply" ? null : xIntentUrl(text)),
  composerLabel: "Open draft",
  kpiFallback: "x",
  hideAccountSnapshot: true,
  analyticsView: "x",
  metricDisplay: X_METRICS,
  maxWidth: "max-w-[1180px]",
  metricLayout: { perRow: 4 },
  extras: ["x_tables"],
  stagedCards: (payload, actions) => xStagedCards(payload, actions as ChannelActionView[]),
  publish: async (action, content, context) => {
    if (action.action_type === "reply") return false;
    const [{ apiFetch }, { publishPost, stagedProposalFor, stagedCardProposal }, { postContent }, { followPostInToast }] = await Promise.all([
      import("@/lib/api"),
      import("../../agent/xStagedPosts"),
      import("../types"),
      import("../topActions/postToast"),
    ]);
    const own = stagedCardProposal(action, "x");
    if (own) {
      const decisionId = await publishPost({ channel: own.channel, staged: own, content });
      void followPostInToast(decisionId, "X", undefined, context?.tenantId);
      return true;
    }
    const res = await apiFetch("/api/agents/x_organic/dashboard");
    if (!res.ok) throw new Error("Zavi could not reach your X account just now. Try again.");
    const payload = (await res.json()) as unknown;
    if ((payload as { connected?: boolean })?.connected !== true) return false;
    const hit = stagedProposalFor(payload, postContent({ ...action, edited_body: null }).text);
    const staged = hit ? { ...hit, post_revision: action.post_revision } : null;
    const decisionId = await publishPost({
      channel: staged?.channel ?? "x",
      staged,
      content,
    });
    void followPostInToast(decisionId, "X", undefined, context?.tenantId);
    return true;
  },
};
