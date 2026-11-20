
import { agentCapabilities } from "./registry";

export const NEUTRAL_RUN_STATUS = "not available";

const EXECUTE_RE =
  /\b(?:run(?:\s+(?:it|that|this))?\s+again|re-?run|redo|re-?generate|regenerate|do\s+(?:it|that|this)\s+again|try\s+again|not\s+success(?:ful)?|wasn['’]?t\s+success(?:ful)?|didn['’]?t\s+work|failed\s+again)\b/i;

const STRONG_RECALL_RE =
  /\b(?:share|show|send|paste|link|find|locate|resend|re-?send)\b/i;
const SOFT_INTERROGATIVE_RE = /\b(?:what|where|which)\b/i;
const RESULT_NOUN_RE =
  /\b(?:result|pdf|report|file|link|artifact|output|doc|document|deck|spreadsheet|csv)\b/i;

function isRecallAsk(text: string): boolean {
  if (STRONG_RECALL_RE.test(text)) return true;
  if (SOFT_INTERROGATIVE_RE.test(text) && RESULT_NOUN_RE.test(text)) return true;
  return false;
}

export const ARTIFACT_PRODUCER_SLUGS: ReadonlySet<string> = new Set([
  "instagram_organic",
  "linkedin_organic",
  "meta_ads",
  "reddit_ads",
  "x_ads",
  "chatgpt_ads",
  "reddit_organic",
  "blog",
  "pinterest_organic",
  "tiktok_ads",
  "tiktok_organic",
  "ugc",
  "x_organic",
  "youtube_organic",
  "youtube_ads",
  "linkedin_ads",
  "email_marketing",
  "sms",
  "research",
  "performance-marketer",
  "growth-lead",
  "dispute-response",
  "pm",
  "content-design",
  "seo-geo",
  "social",
  "google_ads",
  "seo",
  "geo",
  "generated_video",
]);

export function isArtifactProducer(slug: string): boolean {
  return ARTIFACT_PRODUCER_SLUGS.has(slug) || agentCapabilities(slug).emits_artifact;
}

export function isExecuteVerbFollowUp(text: string | null | undefined): boolean {
  if (!text) return false;
  if (isRecallAsk(text)) return false;
  return EXECUTE_RE.test(text);
}

const HIDE_PRIOR_RUN_BODY_TRIGGERS: ReadonlySet<string> = new Set(["slack", "chat"]);

export function shouldHidePriorRunBodies(args: {
  trigger: string | undefined;
  agentSlug: string;
}): boolean {
  return (
    args.agentSlug === "operator" &&
    typeof args.trigger === "string" &&
    HIDE_PRIOR_RUN_BODY_TRIGGERS.has(args.trigger)
  );
}

export function shouldDropForFreshWork(args: {
  trigger: string | undefined;
  agentSlug: string;
  currentText: string | null | undefined;
  rowAgentSlug: string;
}): boolean {
  if (args.trigger !== "slack" || args.agentSlug !== "operator") return false;
  if (!isExecuteVerbFollowUp(args.currentText)) return false;
  return isArtifactProducer(args.rowAgentSlug);
}
