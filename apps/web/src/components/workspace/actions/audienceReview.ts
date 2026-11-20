import { audienceSheet } from "./audienceParse";
import { deliverableOf, deliverableParts, type ActionItem } from "./types";

export const AUDIENCE_REVIEW_LABEL = "Create audience";

export const AUDIENCE_REVIEW_STEPS: readonly string[] = [
  "Read both audiences on this card. Every field has a value, and the ones Zavi chose are marked as Zavi's suggestion.",
  `Press ${AUDIENCE_REVIEW_LABEL}. Zavi saves each audience to your LinkedIn ad account as a saved audience. Saving one spends nothing.`,
  "Zavi tells you anything LinkedIn could not match, and anything a saved audience cannot hold, such as an uploaded customer list.",
  "Use a saved audience when you set up a campaign in LinkedIn.",
];

export const AUDIENCE_SAVED_PREFIX = "Saved to LinkedIn";

export const AUDIENCE_READ_LABEL = "I reviewed it";

export const AUDIENCE_READ_STEPS: readonly string[] = [
  AUDIENCE_REVIEW_STEPS[0],
  `Press ${AUDIENCE_READ_LABEL}. Nothing is saved to LinkedIn from this screen. To save these audiences, open Next steps on the LinkedIn Ads channel.`,
];

export const audienceSteps = (canCreate: boolean): string[] => [...(canCreate ? AUDIENCE_REVIEW_STEPS : AUDIENCE_READ_STEPS)];

export function isAudienceReviewCard(a: ActionItem): boolean {
  if (a.executable || a.channel_slug !== "linkedin_ads" || deliverableParts(a)) return false;
  const d = deliverableOf(a);
  if (d?.kind !== "list" || a.body?.step?.deliverable?.presentation?.type === "campaign_draft") return false;
  return audienceSheet(d.content) !== null;
}
