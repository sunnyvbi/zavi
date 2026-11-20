import type { ActionItem } from "../types";
import type { SecondaryKey } from "../card/ActionCardFrame";
import type { PrimarySpec } from "../card/cardPrimary";
import { isBrief } from "../card/cardKind";

export type OrganicChannelSpec = {
  meta?: string;
  video?: boolean;
  creators?: boolean;
  redo?: Array<{ redo: string; note: string }>;
  rejectOnApprove?: boolean;
  plainSteps?: boolean;
};

export const ORGANIC_CHANNELS: Record<string, OrganicChannelSpec> = {
  x_organic: {},
  linkedin_organic: {},
  reddit_organic: {},
  pinterest_organic: {},
  instagram_organic: { video: true },
  tiktok_organic: { video: true },
  youtube_organic: { video: true },
  blog: {},
  seo: { rejectOnApprove: true, plainSteps: true },
  geo: {},
  email_marketing: {},
  sms: {},
  ugc: { creators: true },
  generated_video: {
    meta: "Credits are charged only when a video arrives",
    creators: true,
    redo: [
      { redo: "Make it shorter", note: "Make it shorter." },
      { redo: "Different presenter", note: "Use a different presenter." },
    ],
  },
};

export function organicChannel(slug: string): OrganicChannelSpec {
  return ORGANIC_CHANNELS[slug] ?? {};
}

const POSTS = new Set(["text_post", "image_post", "video_post", "reply"]);

export function organicSecondary(a: ActionItem, primary: PrimarySpec | null, ch: OrganicChannelSpec): SecondaryKey[] {
  if (ch.redo && a.executable) return ["edit", ...ch.redo];
  if (ch.rejectOnApprove && a.executable) return ["reject"];
  if (isBrief(a)) return ["notNow", "ask"];
  if (a.blocking) return ["ask", "notNow"];
  if (ch.creators && primary?.label.includes("$")) return ["notNow"];
  if (primary?.mode === "publish") return ["edit", "reject"];
  if (primary?.mode === "copy" && a.action_type === "image_post") return ["edit", "reject"];
  if (primary?.mode === "copy" && (POSTS.has(a.action_type) || a.card_kind === "message")) return ch.video ? ["edit", "ask"] : ["edit"];
  return ["ask"];
}
