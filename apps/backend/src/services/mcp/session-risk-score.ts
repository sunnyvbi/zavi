
import { isE3WriteClass, type ToolRiskClass } from "./tool-risk-registry";

export const RISK_POINTS: Record<ToolRiskClass, number> = {
  read: 0,
  write_low: 1,
  write_external: 3,
  write_code: 3,
  write_money: 5,
};

export const DEFAULT_RISK_THRESHOLD = 10;

export function accrueRisk(current: number, cls: ToolRiskClass): number {
  return current + (RISK_POINTS[cls] ?? 0);
}

export function wouldEscalate(
  score: number,
  cls: ToolRiskClass,
  threshold: number = DEFAULT_RISK_THRESHOLD,
): boolean {
  return isE3WriteClass(cls) && score >= threshold;
}
