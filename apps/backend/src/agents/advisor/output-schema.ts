
import { z } from "zod";

export const DISPATCH_ALLOWLIST = [
  "chief-of-staff",
  "performance-marketer",
  "support-lead",
  "dispute-response",
] as const;

const allowlistSet = new Set<string>(DISPATCH_ALLOWLIST);

const stageEnum = z.enum(["pre-launch", "growth", "scale"]);

const diagnosisSchema = z.object({
  stage: stageEnum,
  goal_restated: z.string().min(1).max(500),
  key_signals: z.array(z.string().max(600)).max(8).default([]),
});

const evidenceSchema = z.object({
  source: z.enum(["memory", "slack", "web", "operator_db", "github"]),
  ref: z.string().max(600),
});

const researchFindingSchema = z.object({
  topic: z.enum([
    "competitor_landscape",
    "peer_benchmark",
    "market_size",
    "regulatory",
    "operator_data",
    "other",
  ]),
  summary: z.string().min(1).max(1200),
  evidence: z.array(evidenceSchema).max(5).default([]),
});

const recommendationItemSchema = z.object({
  title: z.string().min(1).max(180),
  rationale: z.string().min(1).max(1200),
  evidence_refs: z.array(z.string().max(300)).max(5).default([]),
  estimated_impact: z.string().max(1200).default(""),
  confidence: z.enum([
    "evidence_grounded",
    "inference",
    "low_confidence_speculation",
  ]),
});

const decideTodayItemSchema = recommendationItemSchema.extend({
  disconfirming_signal: z.string().min(1).max(600),
});

const watchTriggerSchema = z.object({
  trigger: z.string().min(1).max(600),
  what_to_do: z.string().min(1).max(600),
});

const dispatchProposalSchema = z.object({
  agent_slug: z.string().min(1).max(64),
  brief: z.string().min(1).max(1200),
  why: z.string().min(1).max(400),
});

const recommendationsSchema = z.object({
  decide_today: z.array(decideTodayItemSchema).max(5).default([]),
  next_30d: z.array(recommendationItemSchema).max(8).default([]),
  watch_for: z.array(watchTriggerSchema).max(5).default([]),
  lead_priority: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? undefined),
  deprioritize: z.array(z.string().min(1).max(200)).max(3).default([]),
});

const clarificationsSchema = z.union([
  z.literal(false),
  z.object({
    questions: z.array(z.string().min(1).max(400)).min(1).max(5),
  }),
]);

const closeRecommendationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["acted", "rejected", "stale"]),
  reason: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? undefined),
});

const baseSchema = z.object({
  diagnosis: diagnosisSchema,
  research_findings: z.array(researchFindingSchema).max(8).default([]),
  recommendations: recommendationsSchema.default({
    decide_today: [],
    next_30d: [],
    watch_for: [],
    deprioritize: [],
    lead_priority: undefined,
  }),
  dispatch_proposals: z.array(dispatchProposalSchema).max(5).default([]),
  dissent: z
    .object({
      what_not_to_do: z.string().min(1).max(600),
      why: z.string().min(1).max(400),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  clarifications_needed: clarificationsSchema,
  close_recommendations: z.array(closeRecommendationSchema).max(10).default([]),
  rendered_markdown: z.string().min(1).max(20000),
});

export function makeAdviceSchema(allowed: ReadonlySet<string>, label: string) {
  return baseSchema.superRefine((value, ctx) => {
  value.dispatch_proposals.forEach((p, idx) => {
    if (!allowed.has(p.agent_slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dispatch_proposals[${idx}].agent_slug "${p.agent_slug}" is not in the ${label} allowlist`,
        path: ["dispatch_proposals", idx, "agent_slug"],
      });
    }
  });

  if (value.clarifications_needed !== false) {
    if (
      value.research_findings.length > 0 ||
      value.dispatch_proposals.length > 0 ||
      value.recommendations.decide_today.length > 0 ||
      value.recommendations.next_30d.length > 0 ||
      value.recommendations.watch_for.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "clarifications_needed set — recommendations/research_findings/dispatch_proposals must be empty",
        path: ["clarifications_needed"],
      });
    }
  }

  if (value.recommendations.decide_today.length > 0) {
    const lp = value.recommendations.lead_priority;
    if (!lp || lp.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lead_priority is required and non-empty when decide_today is non-empty",
        path: ["recommendations", "lead_priority"],
      });
    }
  }
  });
}

export const adviceSchema = makeAdviceSchema(allowlistSet, "advisor");

export type Advice = z.infer<typeof adviceSchema>;
