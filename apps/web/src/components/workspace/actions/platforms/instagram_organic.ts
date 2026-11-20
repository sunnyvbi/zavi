
import { FileText, Gauge, MessageSquare, Users } from "./_shared";
import { Bookmark, Eye, Heart, Radar } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { POST_APPROVAL, POST_IMAGE, TOPIC, postTextOrZavi } from "../topActions/fieldSets";

const INSTAGRAM_METRICS: Record<string, MetricDisplay> = {
  followers: { label: "Followers", icon: Users },
  total_posts: { label: "Posts", icon: FileText },
  views: { label: "Views", icon: Eye },
  reach: { label: "Reach", icon: Radar },
  engagement_rate: { label: "Engagement rate", icon: Gauge },
  likes: { label: "Likes", icon: Heart },
  comments: { label: "Comments", icon: MessageSquare },
  saves: { label: "Saves", icon: Bookmark },
};

export const instagram_organic: PlatformSpec = {
  name: "Instagram",
  createMenu: "Create post",
  topActions: [
    {
      key: "post_image",
      label: "Post an image",
      modal: "form",
      submit: "social_propose",
      socialChannel: "instagram_image",
      lead: "Add an image. Write the caption, or leave it empty and Zavi writes it. You approve it before it posts.",
      note: POST_APPROVAL,
      fields: [POST_IMAGE, postTextOrZavi("Caption", 2200)],
      primary: "Send for approval",
      done: "Post waiting for your approval on this page. It posts to Instagram when you approve.",
      writes: {
        key: "post_image_write",
        done: "Zavi is writing the caption. The post waits for your approval on this page in a minute or two. Nothing posts until you approve it.",
      },
    },
    {
      key: "draft_reel",
      label: "Draft a Reel",
      modal: "form",
      lead: "A shot list, script and caption for a Reel you film yourself.",
      fields: [TOPIC],
      primary: "Draft the Reel",
      done: "Zavi is writing your Reel plan. It will appear in What Zavi wants to do when ready.",
    },
    {
      key: "rewrite_bio",
      label: "Rewrite my bio",
      modal: "form",
      lead: "Three new versions of your Instagram bio, based on what you sell and who buys.",
      primary: "Write 3 bios",
      done: "Zavi is writing three bio options. They will appear in What Zavi wants to do when ready; copy one into Instagram yourself.",
    },
  ],
  description: "Finds a Reels format that works for you, with episode one and a new bio",
  charLimit: 2200,
  metricDisplay: INSTAGRAM_METRICS,
  metricLayout: { perRow: 4 },
  hideStrategyPrompt: true,
  kpiFallback: "instagram",
  extras: ["instagram_tables"],
  settings: [
    {
      kind: "text",
      id: "handle",
      label: "Your Instagram account",
      help: "The account to research and write for. Use the username without @. This does not change the connected account used for publishing or insights.",
      placeholder: "yourbrand",
    },
    {
      kind: "list",
      id: "competitors",
      label: "Accounts in your category",
      help: "Accounts in your category worth reading for what is earning views. They go to the next run, which only compares you to accounts it actually read.",
    },
  ],
};
