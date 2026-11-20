
import type { DecisionEvidence } from "@/services/agents/decision-evidence";

export function buildShipPrEvidence(
  envelope: Record<string, unknown>,
): DecisionEvidence {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  const title = str(envelope.title).trim();
  const summary = (str(envelope.rendered_markdown) || str(envelope.body)).trim();
  const reason_text =
    [title, summary].filter(Boolean).join(" — ").slice(0, 2000) ||
    "Engineer prepared a code change; opening the PR requires approval.";

  const evidence: string[] = [];
  const files = Array.isArray(envelope.files) ? envelope.files.length : 0;
  if (files > 0) evidence.push(`${files} file(s) changed`);

  const verify = envelope.verify as { status?: unknown; reason?: unknown } | undefined;
  const vs = typeof verify?.status === "string" ? verify.status : "not_run";
  if (vs === "passed") {
    evidence.push("tests: passed (sandbox)");
  } else if (vs === "failed") {
    evidence.push("tests: failed (sandbox)");
  } else if (vs === "couldnt_run") {
    const why = typeof verify?.reason === "string" ? `: ${verify.reason.slice(0, 80)}` : "";
    evidence.push(`tests: couldn't run in sandbox${why}`);
  } else {
    evidence.push("tests: not run in sandbox");
  }

  const risk = str(envelope.risk_class) || "low";
  evidence.push(`risk_class: ${risk}`);

  const blast_radius =
    risk === "trivial" ? "GREEN" : risk === "medium" ? "ORANGE" : "YELLOW";
  const confidence =
    envelope.approval_class === "ship_red" ? 0.3 : vs === "passed" ? 0.8 : 0.5;

  return {
    reason_text,
    evidence,
    alternatives_considered: [],
    reversibility: "reversible_with_cost",
    blast_radius,
    confidence,
  };
}
