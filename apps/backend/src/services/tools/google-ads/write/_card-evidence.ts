
import { z } from "zod";
import type { DecisionEvidence } from "@/services/agents/decision-evidence";

const cardStat = z.object({
  value: z.string().min(1).max(40),
  caption: z.string().min(1).max(140),
});

export const cardEvidenceInputShape = {
  headline: z
    .string()
    .min(3)
    .max(80)
    .optional()
    .catch(() => undefined)
    .describe(
      "The card title: the action and why, in plain words, under 80 characters, e.g. \"Block 10 competitor searches that never booked\".",
    ),
  evidence_stats: z
    .array(cardStat)
    .min(1)
    .max(4)
    .optional()
    .catch(() => undefined)
    .describe(
      "Up to 4 numbers you READ THIS RUN that justify the change, each {value, caption}, e.g. {value:\"$412.60\", caption:\"spent on these terms, 0 conversions\"}. Copy values from tool results; never compute a figure you did not read.",
    ),
  evidence_window: z
    .object({ from: z.string().min(1).max(20), to: z.string().min(1).max(20) })
    .optional()
    .catch(() => undefined)
    .describe("The date range the evidence covers, as YYYY-MM-DD {from, to}."),
  estimate: z
    .array(cardStat)
    .min(1)
    .max(3)
    .optional()
    .catch(() => undefined)
    .describe(
      "Up to 3 expected results of the change, each {value, caption}, e.g. {value:\"≈ $180\", caption:\"freed each month\"}. These are shown labelled as an estimate.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .catch(() => undefined)
    .describe("Your confidence that this change helps, 0 to 1."),
};

export type CardEvidenceInput = {
  headline?: string;
  evidence_stats?: Array<{ value: string; caption: string }>;
  evidence_window?: { from: string; to: string };
  estimate?: Array<{ value: string; caption: string }>;
  confidence?: number;
};

export type GoogleAdsActionKind =
  | "budget"
  | "status_pause"
  | "status_enable"
  | "create"
  | "update"
  | "keywords"
  | "removal";

const RISK: Record<GoogleAdsActionKind, Pick<DecisionEvidence, "reversibility" | "blast_radius">> = {
  budget: { reversibility: "reversible", blast_radius: "YELLOW" },
  status_pause: { reversibility: "reversible", blast_radius: "YELLOW" },
  status_enable: { reversibility: "reversible", blast_radius: "ORANGE" },
  create: { reversibility: "reversible", blast_radius: "GREEN" },
  update: { reversibility: "reversible", blast_radius: "YELLOW" },
  keywords: { reversibility: "reversible", blast_radius: "YELLOW" },
  removal: { reversibility: "irreversible", blast_radius: "RED" },
};

const DEFAULT_CONFIDENCE = 0.6;

export function buildGoogleAdsDecisionEvidence(
  kind: GoogleAdsActionKind,
  rationale: string,
  input: CardEvidenceInput,
): DecisionEvidence {
  return {
    reason_text: rationale,
    evidence: (input.evidence_stats ?? []).map((s) => `${s.value}: ${s.caption}`),
    alternatives_considered: [],
    ...RISK[kind],
    confidence: input.confidence ?? DEFAULT_CONFIDENCE,
    ...(input.headline ? { headline: input.headline } : {}),
    ...(input.evidence_stats ? { stats: input.evidence_stats } : {}),
    ...(input.evidence_window ? { window: input.evidence_window } : {}),
    ...(input.estimate ? { estimate: input.estimate } : {}),
  };
}
