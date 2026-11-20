
import { ExpectedToolError } from "@/services/tools/types";

export const REDO_ALLOWED_DECISION_CLASS = "channel.recipe_step";

export const REDO_DENIED_TOOL_PREFIXES = [
  "google_ads__propose_",
  "meta_ads__propose_",
  "social__propose_",
  "outbound__propose_",
  "fundraising__propose_",
  "generated_video__propose",
  "creator__",
  "seo__propose_",
  "geo__propose_",
  "reddit_ads__propose_",
  "email_campaign__propose_",
  "email__propose_",
  "x_ads__propose_",
  "chatgpt_ads__propose_",
  "linkedin_ads__propose_",
  "tiktok_ads__propose_",
] as const;

export const REDO_NON_EMITTING_PROPOSE_TOOLS: ReadonlySet<string> = new Set([
  "google_ads__propose_video_ad",
]);

export function runCarriesRedo(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const redo = (payload as { redo?: unknown }).redo;
  return !!redo && typeof redo === "object";
}

export const CHAT_ANSWER_DENIED_TOOL_PREFIXES = [
  ...REDO_DENIED_TOOL_PREFIXES,
  "growth__propose_",
  "generated_video__animate",
  "email__plan_send",
  "tiktok__create_post",
  "tiktok__schedule_post",
  "tiktok__update_scheduled_post",
  "tiktok__upload_draft",
] as const;

export function stripProposeToolsOnRedo<T extends { name: string }>(
  tools: T[],
  carriesRedo: boolean,
  chatAnswerTurn = false,
): T[] {
  if (chatAnswerTurn) {
    return tools.filter((t) => !CHAT_ANSWER_DENIED_TOOL_PREFIXES.some((p) => t.name.startsWith(p)));
  }
  if (!carriesRedo) return tools;
  return tools.filter(
    (t) =>
      REDO_NON_EMITTING_PROPOSE_TOOLS.has(t.name) ||
      !REDO_DENIED_TOOL_PREFIXES.some((p) => t.name.startsWith(p)),
  );
}

export const chatAnswerTurnEmit = async (_decision_class?: string, _body?: unknown): Promise<string> => {
  throw new ExpectedToolError(
    "chat_answer_turn",
    "The founder asked a question this turn, not for a card, so nothing was filed. Answer in prose and end with \"Want me to make this a card?\"; they can ask for the card explicitly.",
  );
};

export function redoRefusesClass(carriesRedo: boolean, decision_class: string): boolean {
  return carriesRedo && decision_class !== REDO_ALLOWED_DECISION_CLASS;
}

export function isChatAnswerTurnEmit(emit: unknown): boolean {
  return emit === chatAnswerTurnEmit;
}
