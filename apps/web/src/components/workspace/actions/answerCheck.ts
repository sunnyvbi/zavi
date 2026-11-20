
import type { ActionItem } from "./types";

export const ANSWER_CHECK_SLUG = "geo";

export function isAnswerCheckCard(a: Pick<ActionItem, "channel_slug" | "body">): boolean {
  return a.channel_slug === ANSWER_CHECK_SLUG && a.body?.step?.deliverable?.presentation?.type === "answer_check";
}

export const answerCheckPage = (): string => `/workspace?tab=channels&channel=${ANSWER_CHECK_SLUG}`;

export const ANSWER_CHECK_WORDS = {
  started: "Checking now. Results fill the GEO page as answers come in.",
  notReady: "This check can't run yet. The questions section on the GEO page says why.",
  loading: "The GEO page is still loading. Try again in a moment.",
  running: "A check is already running. Its results show on the GEO page.",
} as const;
