
import {
  START_CARD_CHECK_KEYS,
  START_CARD_POINTS_PER_CHECK,
  type StartCardAiEvidence,
  type StartCardCompareEvidence,
  type StartCardDesignEvidence,
  type StartCardDiagnosisEvidence,
  type StartCardGoogleEvidence,
  type StartCardParts,
  type StartCardProfileEvidence,
  type StartCardScore,
  type StartCardSeoEvidence,
} from "@zavi/shared";
import type { StageContext, StageOutcome } from "./checks/contract";
import { runProfile } from "./checks/profile";
import { runGoogle } from "./checks/google";
import { runAi } from "./checks/ai";
import { runSeo } from "./checks/seo";
import { runDesign } from "./checks/design";
import { runCompare } from "./checks/compare";
import { runDiagnosis } from "./checks/diagnosis";

export { StageUnavailableError, type StageContext, type StageOutcome } from "./checks/contract";

export const SCORER_VERSION = "1";

export async function runProfileStage(ctx: StageContext): Promise<StageOutcome<StartCardProfileEvidence>> {
  return runProfile(ctx);
}

export async function runGoogleStage(ctx: StageContext): Promise<StageOutcome<StartCardGoogleEvidence>> {
  return runGoogle(ctx);
}

export async function runAiStage(ctx: StageContext): Promise<StageOutcome<StartCardAiEvidence>> {
  return runAi(ctx);
}

export async function runSeoStage(ctx: StageContext): Promise<StageOutcome<StartCardSeoEvidence>> {
  return runSeo(ctx);
}

export async function runDesignStage(ctx: StageContext): Promise<StageOutcome<StartCardDesignEvidence>> {
  return runDesign(ctx);
}

export async function runCompareStage(ctx: StageContext): Promise<StageOutcome<StartCardCompareEvidence>> {
  return runCompare(ctx);
}

export function scoreCard(parts: StartCardParts): StartCardScore {
  const by_check = {} as StartCardScore["by_check"];
  let total = 0;
  let out_of = 0;
  for (const key of START_CARD_CHECK_KEYS) {
    const part = parts[key];
    if (part?.state === "done" && typeof part.points === "number") {
      const pts = Math.max(0, Math.min(START_CARD_POINTS_PER_CHECK, part.points));
      by_check[key] = pts;
      total += pts;
      out_of += START_CARD_POINTS_PER_CHECK;
    } else {
      by_check[key] = null;
    }
  }
  return { total, out_of, by_check };
}

export async function runDiagnosisStage(
  ctx: StageContext & { score: StartCardScore },
): Promise<StageOutcome<StartCardDiagnosisEvidence>> {
  return runDiagnosis(ctx);
}
