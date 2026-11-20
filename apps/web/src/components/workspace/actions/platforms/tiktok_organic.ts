
import { FileText, Gauge, MessageSquare, Users } from "./_shared";
import { Eye, Heart, Share2 } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { TOPIC } from "../topActions/fieldSets";

const TIKTOK_METRICS: Record<string, MetricDisplay> = {
  followers: { label: "Followers", icon: Users },
  total_posts: { label: "Posts", icon: FileText },
  views: { label: "Views", icon: Eye },
  engagement_rate: { label: "Engagement rate", icon: Gauge },
  likes: { label: "Likes", icon: Heart },
  comments: { label: "Comments", icon: MessageSquare },
  shares: { label: "Shares", icon: Share2 },
};

export const tiktok_organic: PlatformSpec = {
  name: "TikTok",
  createMenu: "New video",
  topActions: [
    {
      key: "write_script",
      label: "Write a video script",
      modal: "form",
      lead: "A hook, a script and a caption for one TikTok you film.",
      fields: [TOPIC],
      primary: "Write the script",
      done: "Script added to What Zavi wants to do.",
    },
    {
      key: "send_to_drafts",
      label: "Send video to TikTok drafts",
      modal: "form",
      submit: "tiktok_drafts",
      lead: "Upload a finished video. It lands in your TikTok drafts; you add the caption and post it from the TikTok app.",
      note: "Nothing posts publicly. It goes to your drafts only.",
      fields: [{ kind: "video", name: "video_path", label: "Video", from: "videos", uploadOnly: true }],
      consent: "Send this video to my TikTok drafts. I finish and post it myself in the TikTok app.",
      primary: "Send to my TikTok drafts",
      done: "Sent. Open your TikTok drafts to add the caption and post it.",
    },
  ],

  metricDisplay: TIKTOK_METRICS,
  metricLayout: { perRow: 4 },
  kpiFallback: "tiktok",
  extras: ["tiktok_tables"],

  settings: [
    {
      kind: "text",
      id: "username",
      label: "Your TikTok username",
      help: "Just the username, without the @ and not the profile URL. That is the form the lookup takes. Without it every run has to find you by search first, and may read someone else.",
      placeholder: "yourcompany",
    },
    {
      kind: "choice",
      id: "on_camera",
      label: "Who can be on camera",
      help: "The shot list is written for whoever can actually film. A correct “nobody” is a real answer here, not a failure.",
      options: [
        { value: "face", label: "Someone will appear on camera" },
        { value: "hands_voice", label: "Hands and voiceover only, no face" },
        { value: "nobody", label: "Nobody can film right now" },
      ],
    },
    {
      kind: "text",
      id: "destination",
      label: "Where a viewer should land",
      help: "Only the bio link is clickable on TikTok. This is the page the bio and the pinned comment point at.",
      placeholder: "https://example.com/book",
    },
  ],
};
