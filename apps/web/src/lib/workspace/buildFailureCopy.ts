
import {
  BUILD_INTERNAL_FAILURE,
  BUILD_NO_CREDITS_TO_START,
  BUILD_OUT_OF_CREDITS,
  BUILD_OVER_BUDGET,
  BUILD_PROVIDER_BUSY,
  founderBuildFailure,
  isFounderBuildFailureCode,
  isFounderBuildLine,
  isOutOfCreditsReason,
} from "@zavi/shared";

export {
  BUILD_INTERNAL_FAILURE,
  BUILD_NO_CREDITS_TO_START,
  BUILD_OUT_OF_CREDITS,
  BUILD_OVER_BUDGET,
  BUILD_PROVIDER_BUSY,
};

export const CHANGE_OUT_OF_CREDITS =
  "This change didn't run: there weren't enough credits for it. Nothing further will be charged.";

export function isOutOfCreditsFailure(reason: string | null | undefined): boolean {
  return isOutOfCreditsReason(reason);
}

export function changeFailureCopy(reason: string | null | undefined): string | null {
  return isOutOfCreditsFailure(reason) ? CHANGE_OUT_OF_CREDITS : null;
}

export type BuildFailureLike = {
  class?: string | null;
  code?: string | null;
  message?: string | null;
  stage?: string | null;
};

export function isOutOfCreditsBuild(failure: BuildFailureLike | null | undefined): boolean {
  if (!failure) return false;
  if (isFounderBuildFailureCode(failure.code)) return failure.code === "out_of_credits";
  return isOutOfCreditsFailure(failure.message);
}

export function buildFailureLine(
  failure: BuildFailureLike | null | undefined,
  opts: { startedWork?: boolean } = {},
): string | null {
  if (!failure) return null;
  const message = (failure.message ?? "").trim();
  if (isFounderBuildFailureCode(failure.code)) return message || BUILD_INTERNAL_FAILURE;
  return founderBuildFailure(failure, opts)?.message ?? null;
}

export function stageErrorLine(error: string | null | undefined): string | null {
  const text = (error ?? "").trim();
  if (!text) return null;
  return isFounderBuildLine(text) ? text : buildFailureCopy(text);
}

export function buildFailureCopy(
  reason: string | null | undefined,
  opts: { startedWork?: boolean } = {},
): string | null {
  if (!reason || !reason.trim()) return null;
  return founderBuildFailure({ message: reason }, opts)?.message ?? null;
}
