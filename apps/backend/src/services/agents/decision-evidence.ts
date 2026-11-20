
import { z } from "zod";

export const REVERSIBILITY = ["reversible", "reversible_with_cost", "irreversible"] as const;
export const BLAST_RADIUS = ["GREEN", "YELLOW", "ORANGE", "RED"] as const;

export const decisionEvidenceSchema = z.object({
  reason_text: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  alternatives_considered: z.array(z.string()).default([]),
  reversibility: z.enum(REVERSIBILITY),
  blast_radius: z.enum(BLAST_RADIUS),
  confidence: z.number().min(0).max(1),
  headline: z.string().optional(),
  stats: z.array(z.object({ value: z.string(), caption: z.string() })).optional(),
  window: z.object({ from: z.string(), to: z.string() }).optional(),
  estimate: z.array(z.object({ value: z.string(), caption: z.string() })).optional(),
});

export type DecisionEvidence = z.infer<typeof decisionEvidenceSchema>;

export class DecisionEvidenceError extends Error {
  readonly noWrite = true as const;
  constructor(message: string) {
    super(message);
    this.name = "DecisionEvidenceError";
  }
}

function extractEvidence(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as Record<string, unknown>).decision_evidence;
  }
  return undefined;
}

export function validateDecisionEvidenceInBody(
  body: unknown,
  opts: { decision_class: string },
): void {
  const ev = extractEvidence(body);
  if (ev === undefined || ev === null) return;
  const parsed = decisionEvidenceSchema.safeParse(ev);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new DecisionEvidenceError(
      `malformed decision_evidence for decision_class="${opts.decision_class}": ${detail}`,
    );
  }
}
