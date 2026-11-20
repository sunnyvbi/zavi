
export type BriefBackfillAction =
  | "skip_no_story"
  | "skip_would_empty"
  | "skip_already_current"
  | "render";

export type BriefBackfillInput = {
  hasStory: boolean;
  renderedBody: string | null;
  liveBody: string | null;
};

export function planBriefBackfill(input: BriefBackfillInput): BriefBackfillAction {
  if (!input.hasStory) return "skip_no_story";
  if (!input.renderedBody) return "skip_would_empty";
  if (input.liveBody !== null && input.liveBody === input.renderedBody) {
    return "skip_already_current";
  }
  return "render";
}

export function isWriteAction(action: BriefBackfillAction): boolean {
  return action === "render";
}
