export const PARTIAL_RISK_EXEC_CODES = ["exec_partial", "exec_outcome_unknown"] as const;

export type PartialRiskExecCode = (typeof PARTIAL_RISK_EXEC_CODES)[number];

export function isPartialRiskExecCode(code: unknown): code is PartialRiskExecCode {
  return typeof code === "string" && (PARTIAL_RISK_EXEC_CODES as readonly string[]).includes(code);
}
