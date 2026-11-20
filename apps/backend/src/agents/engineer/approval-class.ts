
import type { VerifyStatus } from "./engineer-verify-receipt";
import type { TestAttribution } from "./engineer-test-baseline";

export type ApprovalClass =
  | "ship_red"
  | "soft_yes_red"
  | "soft_yes_couldnt_run"
  | "soft_yes_not_run"
  | "normal_yes";

export function requiresExplicitShipRed(cls: ApprovalClass): boolean {
  return cls === "ship_red";
}

export function isSoftYes(cls: ApprovalClass): boolean {
  return (
    cls === "soft_yes_red" ||
    cls === "soft_yes_couldnt_run" ||
    cls === "soft_yes_not_run"
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function classifyEngineerPrApproval(envelope: unknown): ApprovalClass {
  const env = asRecord(envelope);

  const riskClass =
    typeof env.risk_class === "string" ? env.risk_class : undefined;
  if (riskClass === "trivial") return "normal_yes";

  const verify = asRecord(env.verify);
  const status: VerifyStatus | undefined =
    verify.status === "passed" ||
    verify.status === "failed" ||
    verify.status === "couldnt_run" ||
    verify.status === "not_run"
      ? (verify.status as VerifyStatus)
      : undefined;

  if (status === undefined || status === "passed") return "normal_yes";

  if (status === "couldnt_run") return "soft_yes_couldnt_run";
  if (status === "not_run") return "soft_yes_not_run";

  const attribution = env.test_attribution as TestAttribution | undefined;
  const attr = asRecord(attribution);
  const attributed = attr.kind === "attributed";
  const newFailures = Array.isArray(attr.new_failures) ? attr.new_failures : [];

  if (attributed && newFailures.length > 0) return "ship_red";

  if (attributed && newFailures.length === 0) return "normal_yes";

  return "soft_yes_red";
}

export function readApprovalClass(v: unknown): ApprovalClass | null {
  const s = asRecord(v).approval_class;
  return s === "ship_red" ||
    s === "soft_yes_red" ||
    s === "soft_yes_couldnt_run" ||
    s === "soft_yes_not_run" ||
    s === "normal_yes"
    ? s
    : null;
}
