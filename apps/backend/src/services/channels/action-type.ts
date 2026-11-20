
import { coerceActionType, type ActionType } from "@zavi/shared";

export type DerivableStep = {
  title?: unknown;
  deliverable?: {
    kind?: unknown;
    presentation?: { type?: unknown; post_type?: unknown } | null;
  } | null;
};

const SETUP_TITLE_RE =
  /\b(?:re)?(?:connect|connects|connecting)\b|\b(?:link|links|linking|register|registers|registering|claim|claims|claiming|pin|pins|pinning|set\s+up|sign\s+up|create\s+(?:an?\s+)?account|decide\s+(?:on\s+)?(?:a|the|your)?\s*handle|choose\s+(?:a|the|your)?\s*handle|pick\s+(?:a|the|your)?\s*handle)\b/i;

const CHECK_TITLE_RE =
  /\b(?:confirm|confirms|confirming|check|checks|checking|verify|verifies|verifying|pull|pulls|pulling|review|reviews|reviewing|measure|measures|measuring|send\s+back|report\s+back)\b/i;

const NEW_PAGE_EXPLICIT_RE = /\b(?:new|missing|net-new|nonexistent|non-existent)\b[^.;!?]{0,60}?\bpage\b/i;

const PAGE_EDIT_TITLE_RE =
  /\b(?:titles?|meta|descriptions?|h1s?|h2s?|headings?|schema|json-?ld|structured\s+data|markup|canonicals?|tags?|redirects?|sitemaps?|robots(?:\.txt)?|alt\s+text|internal\s+links?|anchor\s+text|tracking|analytics|breadcrumbs?|hreflang)\b/i;

const NEW_PAGE_VERB_RE =
  /\b(?:build|builds|building|create|creates|creating|draft|drafts|drafting|write|writes|writing|publish|publishes|publishing|launch|launches|launching|ship|ships|shipping|stand\s+up)\b[^.;!?]{0,60}?\bpage\b/i;

const ARTICLE_TITLE_RE = /\b(?:blogs?|articles?)\b/i;

const PAGE_READ_HEAD_RE = /^\s*(?:audit|research|crawl|re-?crawl|re-?read)\w*\b/i;

const PAGE_FIRST_CHANNELS = new Set(["seo", "geo"]);

const MESSAGE_KINDS = new Set(["post", "thread", "comment", "dm", "email", "sms"]);

const SENDER_SETUP_TITLE_RE =
  /\b(?:spf|dkim|dmarc|mta-?sts|bimi|dns|txt\s+record|10\s?dlc|toll-?free|campaign\s+registry|short\s?codes?|sending\s+domain|sender\s+(?:domain|identity|reputation)|subdomain|warm[\s-]?ups?|warming|deliverability|bounces?|suppression|blocklist|unsubscribes?|opt-?ins?|opt-?outs?|consent|list\s+hygiene|scrub|sunset|dedupe|de-?duplicate|registrations?|register|registering|verification|provision)\b/i;

const MESSAGE_FIRST_CHANNELS = new Set(["email_marketing", "sms"]);

function messageFirstActionType(
  channelSlug: string,
  kind: string | null,
  title: string,
): ActionType | null {
  if (kind === null && CHECK_TITLE_RE.test(title)) return "check";
  if (kind !== null && MESSAGE_KINDS.has(kind)) return "send_message";
  if ((kind === null || kind === "list") && SENDER_SETUP_TITLE_RE.test(title)) {
    return channelSlug === "sms" ? "setup" : "fix";
  }
  return null;
}

const ACCEPT_CHECK_TITLE_RE =
  /\b(?:watch|watches|watching|tick|ticks|ticking|check|checks|checking|checklist|inspect|inspects|inspecting|delivered|before\s+you\s+pay|before\s+paying)\b/i;

const POSTING_PLAN_TITLE_RE =
  /\b(?:post|posts|posting|publish|publishes|publishing|schedule|schedules|scheduling|upload|uploads|uploading)\b[^.;!?]{0,60}?\b(?:takes?|cuts?|clips?|videos?|hooks?|assets?)\b/i;

const CRAFT_FIRST_CHANNELS = new Set(["ugc"]);

function craftFirstActionType(kind: string | null, title: string): ActionType | null {
  if (kind !== null && MESSAGE_KINDS.has(kind)) return "send_message";
  if (kind === "list") {
    if (ACCEPT_CHECK_TITLE_RE.test(title)) return "check";
    if (POSTING_PLAN_TITLE_RE.test(title)) return "video_post";
  }
  return null;
}

const IMAGE_FIRST_CHANNELS = new Set(["pinterest_organic"]);

function imageFirstActionType(kind: string | null): ActionType | null {
  return kind === "post" ? "image_post" : null;
}

function pageFirstActionType(kind: string | null, title: string): ActionType | null {
  if (kind === null && (CHECK_TITLE_RE.test(title) || PAGE_READ_HEAD_RE.test(title))) return "check";
  if (kind !== null && kind !== "page_copy") return null;
  if (NEW_PAGE_EXPLICIT_RE.test(title)) return "page";
  if (PAGE_EDIT_TITLE_RE.test(title)) return "fix";
  if (NEW_PAGE_VERB_RE.test(title)) return "page";
  if (ARTICLE_TITLE_RE.test(title)) return "text_post";
  return kind === "page_copy" ? "fix" : null;
}

const IMAGE_CHANNELS = new Set(["x_image", "linkedin_image", "instagram_image", "pinterest_pin"]);
const VIDEO_CHANNELS = new Set(["x_video", "youtube_video", "tiktok_video", "instagram_video", "linkedin_video"]);

function actionTypeFromPresentation(
  presentation: { type?: unknown; post_type?: unknown } | null | undefined,
): ActionType | null {
  const type = typeof presentation?.type === "string" ? presentation.type : null;
  if (type === "reddit_reply") return "reply";
  if (type === "reddit_post") {
    return presentation?.post_type === "image" ? "image_post" : "text_post";
  }
  return null;
}

export function actionTypeFromStep(
  kind: string | null,
  title: string,
  stagedChannel: string | null,
  presentation: { type?: unknown; post_type?: unknown } | null = null,
): ActionType {
  const fromPresentation = actionTypeFromPresentation(presentation);
  if (fromPresentation) return fromPresentation;
  switch (kind) {
    case "post":
    case "thread":
      if (stagedChannel && IMAGE_CHANNELS.has(stagedChannel)) return "image_post";
      if (stagedChannel && VIDEO_CHANNELS.has(stagedChannel)) return "video_post";
      return "text_post";
    case "comment":
      return "reply";
    case "dm":
    case "email":
    case "sms":
      return "send_message";
    case "ad":
      return "create_ad";
    case "page_copy":
      return "fix";
    case "script":
      return "video_post";
    case "code":
      return "fix";
    case "brief":
      return "check";
    case "article":
      return "text_post";
    case "strategy":
      return "check";
    case "proof_topics":
      return "check";
    case "proof_page":
      return "page";
    case "list":
    case "other":
      return "other";
    default:
      if (CHECK_TITLE_RE.test(title)) return "check";
      return SETUP_TITLE_RE.test(title) ? "setup" : "check";
  }
}

export const ACTION_TYPE_FAMILY_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
  page_first: PAGE_FIRST_CHANNELS,
  message_first: MESSAGE_FIRST_CHANNELS,
  craft_first: CRAFT_FIRST_CHANNELS,
  image_first: IMAGE_FIRST_CHANNELS,
};

export function deriveActionType(
  channelSlug: string,
  step: DerivableStep,
  stagedChannel: string | null = null,
): { action_type: ActionType; coerced: boolean } {
  const kind = typeof step.deliverable?.kind === "string" ? step.deliverable.kind : null;
  const title = typeof step.title === "string" ? step.title : "";
  const presentation = step.deliverable?.presentation ?? null;
  const family = PAGE_FIRST_CHANNELS.has(channelSlug)
    ? pageFirstActionType(kind, title)
    : MESSAGE_FIRST_CHANNELS.has(channelSlug)
      ? messageFirstActionType(channelSlug, kind, title)
      : CRAFT_FIRST_CHANNELS.has(channelSlug)
        ? craftFirstActionType(kind, title)
        : IMAGE_FIRST_CHANNELS.has(channelSlug)
          ? imageFirstActionType(kind)
          : null;
  return coerceActionType(
    channelSlug,
    family ?? actionTypeFromStep(kind, title, stagedChannel, presentation),
  );
}
