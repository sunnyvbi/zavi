
import { coerceCompanyShape } from "@/services/agents/shape-visibility";

export function isSupplyDemandReachable(rawCompanyShape: unknown): boolean {
  const shape = coerceCompanyShape(rawCompanyShape);
  return shape === null || shape === "other" || shape === "marketplace";
}

export function isSupplyDemandEligible(
  rawCompanyShape: unknown,
  hasConfirmedMapping: boolean,
): boolean {
  const shape = coerceCompanyShape(rawCompanyShape);
  if (shape === "marketplace") return true;
  if (shape !== null && shape !== "other") return false;
  return hasConfirmedMapping === true;
}
