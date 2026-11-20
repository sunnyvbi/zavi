export {
  ESTIMATE_SLOW_FACTOR,
  WAITING_FOR_PICK,
  buildEstimateText,
  buildRemainingMs,
  type EstimateOptions,
  type EstimateStage,
} from "@zavi/shared";

export function designAwaitsPick(
  design: { awaiting_pick?: boolean; picked?: boolean } | null | undefined,
  started: string | null = null,
): boolean {
  return !!design && design.awaiting_pick === true && design.picked !== true && started === null;
}
