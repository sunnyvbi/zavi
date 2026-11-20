
export type CorrectionCase = {
  tenant_id: string;
  agent_slug: string;
  decision_class: string;
  before_body: Record<string, unknown>;
  after_body: Record<string, unknown>;
};

export type CorrectionReplayResult = {
  result: "pass" | "fail";
  reason: string;
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRejectCase(c: CorrectionCase): boolean {
  return c.after_body?.should_not_emit === true;
}

export function replayCorrectionCase(
  c: CorrectionCase,
  observed: Record<string, unknown> | null | undefined,
): CorrectionReplayResult {
  if (isRejectCase(c)) {
    if (observed == null) {
      return { result: "pass", reason: "agent emitted nothing for the rejected situation" };
    }
    return {
      result: "fail",
      reason: `agent still emitted a ${c.decision_class} decision that staff rejected`,
    };
  }

  if (observed == null) {
    return { result: "fail", reason: "agent emitted nothing where a corrected output was expected" };
  }
  const after = c.after_body ?? {};
  for (const key of Object.keys(after)) {
    if (!deepEqual(after[key], observed[key])) {
      return {
        result: "fail",
        reason: `field '${key}' does not match the corrected value`,
      };
    }
  }
  return { result: "pass", reason: "output matches the corrected shape" };
}
