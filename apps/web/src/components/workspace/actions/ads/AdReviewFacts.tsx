import type { ReactNode } from "react";
import type { AdReviewModel } from "./adReviewModel";
import { ActionCardFacts } from "../ActionCardFacts";

export function AdReviewFacts({ description, model, platformName }: { description: ReactNode; model: AdReviewModel; platformName?: string }) {
  return <ActionCardFacts prefix="ad" description={description} cost={model.cost} provenance={model.provenance} destination={platformName} />;
}
