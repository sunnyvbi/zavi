
import { z } from "zod";

export const CODE_DISPATCH_TARGETS = ["agent_prompt", "frontend", "backend", "docs", "config"] as const;
const ALL_TARGETS = [...CODE_DISPATCH_TARGETS, "product"] as const;

const severityEnum = z.enum(["low", "medium", "high"]);

export const clampedText = (min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.length > max ? clampToWord(v, max) : v),
    z.string().min(min).max(max),
  );

function clampToWord(v: string, max: number): string {
  if (max <= 1) return v.slice(0, max);
  const room = max - 1;
  const head = v.slice(0, room);
  const lastSpace = head.lastIndexOf(" ");
  const body = lastSpace > room * 0.6 ? head.slice(0, lastSpace) : head;
  return `${body.replace(/[\s,;:.-]+$/, "")}\u2026`;
}

export const softMeta = (max: number, fallback = "") =>
  z.string().min(1).max(max).catch(fallback);

export const clampedArray = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess(
    (v) => (Array.isArray(v) && v.length > max ? v.slice(0, max) : v),
    z.array(item).max(max),
  );

const evidenceSourceSchema = z.object({
  agent_run_id: z.string().min(1).max(120),
  summary: z.string().max(500).default(""),
});

const priorityOverrideSchema = z.object({
  rank: z.number().int().min(1).max(15),
  reason_class: z.enum([
    "dependency",
    "table_stakes",
    "money_or_compliance",
    "churn_risk_anchor",
  ]),
  depends_on_item_id: z.string().min(1).max(80).nullish(),
  rationale: clampedText(1, 300),
});

const backlogItemSchema = z.object({
  item_id: z.string().min(1).max(80),
  theme: z.string().min(1).max(200),
  theme_normalized: z.string().min(1).max(200),
  problem: clampedText(1, 1000),
  proposed_fix: clampedText(1, 1000),
  target: z.enum(ALL_TARGETS),
  code_reach: z.number().int().min(0).max(1000),
  code_confidence: z.number().int().min(0).max(100),
  impact: severityEnum,
  effort: severityEnum,
  customer_impact: severityEnum.nullish(),
  priority_override: priorityOverrideSchema.nullish(),
  reversal_trigger: z.string().min(1).max(300).nullish(),
  rice_score: z.number().min(0).max(10000),
  reasoning: clampedText(1, 1000),
  evidence_sources: clampedArray(evidenceSourceSchema, 20).default([]),
});

const dispatchedActionSchema = z.object({
  item_id: z.string().min(1).max(80),
  target_agent_slug: z.literal("engineer"),
  task_description: clampedText(12, 2000),
  repo_hint: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "repo_hint must be 'owner/name'")
    .optional()
    .or(z.literal("")),
  file_hints: z.array(z.string().min(1).max(200)).min(1).max(20),
  child_run_id: z.string().min(1).max(120),
  acceptance_criteria: z.array(z.string().min(1).max(300)).max(8).default([]),
  edge_cases: z.array(z.string().min(1).max(300)).max(8).default([]),
});

const recommendedActionSchema = z.object({
  item_id: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  target_team: z.string().min(1).max(120),
  urgency: z.enum(["now", "this-week", "this-month"]),
  needs_go: z.boolean().default(false),
});

const sourceRefSchema = z.object({
  tool_name: softMeta(120),
  query_summary: softMeta(500),
  fetched_at: softMeta(50),
});

const productPmClarificationsSchema = z.union([
  z.literal(false),
  z.object({ questions: z.array(z.string().min(1).max(400)).min(1).max(5) }),
]);
const reframeOptionSchema = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(1200),
  metrics: z.array(z.string().min(1).max(200)).max(6).default([]),
  reversal_trigger: z.string().min(1).max(300).nullish(),
  rank: z.number().int().min(1).max(7),
});
const strategyBlockSchema = z.object({
  premise_check: z.string().max(1200).default(""),
  reframe_options: z.array(reframeOptionSchema).max(7).default([]),
  research_findings: z
    .array(
      z.object({
        summary: z.string().min(1).max(800),
        source: z.string().max(300).default(""),
      }),
    )
    .max(8)
    .default([]),
  clarifications_needed: productPmClarificationsSchema.default(false),
});

export function stripDollarFigures<T>(value: T): T {
  if (typeof value === "string") {
    let s = value as string;
    let prev: string;
    do {
      prev = s;
      s = s.replace(/\$(\s?\d)/g, "$1");
    } while (s !== prev);
    return s as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripDollarFigures(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDollarFigures(v);
    }
    return out as unknown as T;
  }
  return value;
}

export const productPmBacklogSchema = z
  .object({
    status: z.enum(["actionable", "no_signal", "insufficient_data", "strategy_memo"]),
    status_reason: z.string().max(500).nullish(),
    strategy: strategyBlockSchema.optional(),
    rendered_markdown: z.string().max(16000).optional(),
    summary: z
      .object({
        bullets: clampedArray(z.string().min(1).max(400), 3).default([]),
        top_theme: z.string().max(200).optional(),
      })
      .default({ bullets: [] }),
    backlog: clampedArray(backlogItemSchema, 25).default([]),
    dispatched_actions: clampedArray(dispatchedActionSchema, 3).default([]),
    recommended_actions_not_dispatched: clampedArray(recommendedActionSchema, 25).default([]),
    sources_all: z
      .preprocess(
        (v) => (Array.isArray(v) ? v.slice(0, 50) : v),
        z.array(sourceRefSchema).max(50),
      )
      .catch([])
      .default([]),
    snapshot_run_id: z.string().min(1).max(120).optional(),
    artifact_label: z.string().min(1).max(120).nullish(),
  })
  .overwrite((value) => {
    const blob = JSON.stringify(value);
    const matches = blob.match(/\$\s?\d/g);
    if (!matches) return value;
    console.warn(
      `[pm output-schema] dollar-sign auto-stripped from envelope (${matches.length} occurrence(s)) — display-policy coercion, run preserved`,
    );
    return stripDollarFigures(value);
  })
  .superRefine((value, ctx) => {
    const isStrategy = value.status === "strategy_memo";
    if (isStrategy) {
      if (
        value.backlog.length > 0 ||
        value.dispatched_actions.length > 0 ||
        value.recommended_actions_not_dispatched.length > 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "strategy_memo must not carry backlog / dispatched_actions / recommended_actions_not_dispatched (delivery-only).",
          path: ["status"],
        });
      }
      const s = value.strategy;
      if (!s) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "strategy_memo requires a strategy block.",
          path: ["strategy"],
        });
      } else if (s.reframe_options.length === 0 && s.clarifications_needed === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "strategy_memo requires reframe_options[] OR clarifications_needed.",
          path: ["strategy"],
        });
      }
    } else if (value.strategy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status='${value.status}' must not include a strategy block (strategy_memo only).`,
        path: ["strategy"],
      });
    }

    const blob = JSON.stringify(value);
    if (/\$\s?\d/.test(blob)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "product_pm_backlog must not contain dollar figures. Operator-side scenario math owns $-impact.",
        path: ["summary"],
      });
    }

    if (value.status === "actionable" && value.backlog.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status='actionable' requires backlog.length >= 1. Use 'no_signal' for empty results.",
        path: ["status"],
      });
    }
    if (value.status === "no_signal" && value.backlog.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status='no_signal' requires backlog.length === 0. Use 'actionable' if there are items.",
        path: ["status"],
      });
    }

    const itemIds = new Set(value.backlog.map((b) => b.item_id));
    for (let i = 0; i < value.dispatched_actions.length; i++) {
      const d = value.dispatched_actions[i];
      if (!itemIds.has(d.item_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dispatched_actions[${i}].item_id '${d.item_id}' has no matching backlog entry.`,
          path: ["dispatched_actions", i, "item_id"],
        });
      }
    }

    const itemById = new Map(value.backlog.map((b) => [b.item_id, b]));
    for (let i = 0; i < value.dispatched_actions.length; i++) {
      const d = value.dispatched_actions[i];
      const item = itemById.get(d.item_id);
      if (!item) continue;
      if (!(CODE_DISPATCH_TARGETS as readonly string[]).includes(item.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dispatched_actions[${i}] target='${item.target}' is not a code-shape target. Allowed for dispatch: ${CODE_DISPATCH_TARGETS.join(", ")}. Move to recommended_actions_not_dispatched instead.`,
          path: ["dispatched_actions", i, "item_id"],
        });
      }
    }
  });

export type ProductPmBacklog = z.infer<typeof productPmBacklogSchema>;
