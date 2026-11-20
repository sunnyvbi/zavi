
import type { LinkedInMetricKey } from "../../metrics/linkedinMetrics";
import { postContent } from "../types";
import { stagedCardsFromPayload } from "../../agent/xStagedPosts";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { FileText, Gauge, Users } from "./_shared";
import { CalendarClock, MessageSquareText, Repeat2, ThumbsUp } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { POST_APPROVAL, POST_IMAGE, TOPIC, postTextOrZavi } from "../topActions/fieldSets";
import { SOCIAL_LIMITS } from "@zavi/shared";

const LINKEDIN_METRICS = {
  followers: { label: "Followers", icon: Users },
  total_posts: { label: "Posts collected", icon: FileText },
  engagement_rate: { label: "Engagement per follower", sub: "Average per collected post; not an impression-based rate", icon: Gauge },
  reactions: { label: "Reactions", icon: ThumbsUp },
  comments: { label: "Comments", icon: MessageSquareText },
  reposts: { label: "Reposts", icon: Repeat2 },
  days_since_last_post: { label: "Days since last post", icon: CalendarClock },
} satisfies Record<LinkedInMetricKey, MetricDisplay>;

export const linkedin_organic: PlatformSpec = {
  name: "LinkedIn",
  accountFromPayload: payload => {
    const name = (payload as { publishing_account?: { name?: unknown } } | null)?.publishing_account?.name;
    return typeof name === "string" && name.trim() ? { name: name.trim(), handle: "Connected publishing profile" } : undefined;
  },
  hidePublishingAccount: true,
  createMenu: "Create post",
  topActions: [
    {
      key: "new_post",
      label: "New post",
      modal: "form",
      lead: "One post for your personal profile, in your voice. Nothing posts until you press Post on it.",
      fields: [TOPIC],
      primary: "Write the post",
      done: "Zavi is writing your post. It will appear in What Zavi wants to do when ready. Nothing publishes until you press Post.",
    },
    {
      key: "post_image",
      label: "Post with image",
      modal: "form",
      submit: "social_propose",
      socialChannel: "linkedin_image",
      lead: "Add an image for your personal LinkedIn profile. Write the post, or leave it empty and Zavi writes it. You approve it before it posts.",
      note: POST_APPROVAL,
      fields: [POST_IMAGE, postTextOrZavi("Post", 3000)],
      primary: "Send for approval",
      done: "Post waiting for your approval on this page. It posts to LinkedIn when you approve.",
      writes: {
        key: "post_image_write",
        done: "Zavi is writing the post. It waits for your approval on this page in a minute or two. Nothing posts until you approve it.",
      },
    },
    {
      key: "draft_comments",
      label: "Draft comment",
      modal: "form",
      lead: "Comments for other people's posts. You post them yourself.",
      note: "Copy only. Zavi never posts these.",
      fields: [{ kind: "area", name: "posts", label: "Post links (optional)", placeholder: "Or Zavi picks posts in your space", optional: true, max: 2000 }],
      primary: "Draft comments",
      done: "Zavi is checking the posts and drafting any comments it can. Finished drafts appear in What Zavi wants to do. You copy and post them yourself.",
    },
  ],
  description: "Writes this week's post, profile copy and comment openers",
  charLimit: SOCIAL_LIMITS.linkedin.text,
  measure: (text) => text.length,
  composerUrl: (text, a) =>
    a.action_type === "reply"
      ? null
      : `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`,
  composerLabel: "Open draft in browser account",
  stagedCards: (payload, actions) => stagedCardsFromPayload(payload, actions as ChannelActionView[], (draft, action) => {
    const original = postContent({ ...action, edited_body: null }).text;
    const key = (text: string) => text.trim().replace(/\s+/g, " ");
    return key(draft.original_text ?? draft.text) === key(original);
  }),
  publish: async (action, content) => {
    if (action.action_type === "reply") return false;
    const [{ apiFetch }, { publishPost, stagedProposalFor, stagedCardProposal }, { postContent }] = await Promise.all([
      import("@/lib/api"),
      import("../../agent/xStagedPosts"),
      import("../types"),
    ]);
    let hit = stagedCardProposal(action, "linkedin");
    if (!hit) {
      const res = await apiFetch("/api/agents/linkedin_organic/dashboard");
      if (!res.ok) throw new Error("Zavi could not check what is already waiting to post. Try again.");
      const original = postContent({ ...action, edited_body: null }).text;
      const key = (text: string) => text.trim().replace(/\s+/g, " ");
      hit = stagedProposalFor(await res.json(), original, { exact: true, matches: draft => key(draft.original_text ?? draft.text) === key(original) });
    }
    const staged = hit ? { ...hit, post_revision: action.post_revision, thread: null } : null;
    await publishPost({ channel: staged?.channel ?? "linkedin", staged, content: { ...content, thread: null }, platform: "LinkedIn" });
    return true;
  },
  metricDisplay: LINKEDIN_METRICS,
  metricLayout: { perRow: 4 },
  kpiFallback: "linkedin",
  extras: ["linkedin_tables"],
  settings: [
    {
      kind: "text",
      id: "profile_url",
      label: "LinkedIn page to audit and use as reference",
      help: "A personal /in/ profile or company page for research and public metrics. This does not select the publishing account. Post in Zavi uses the personal profile connected in Integrations. Open draft uses the account signed in to LinkedIn in your browser.",
      placeholder: "https://www.linkedin.com/in/your-handle/",
    },
    {
      kind: "list",
      id: "targets",
      label: "Accounts to comment under",
      help: "Accounts whose posts you want comments drafted under. Pick ones your buyer already reads, not a direct competitor. They go to the next run.",
    },
  ],
};
