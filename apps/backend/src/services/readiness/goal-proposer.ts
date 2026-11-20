
import { callModel } from "@/services/llm/call-model";
import { MODELS } from "@/services/llm/models";

export const MEASURABLE_METRICS = ["signups", "bookings", "activations", "purchases", "key_actions"] as const;
export type MeasurableMetric = (typeof MEASURABLE_METRICS)[number];

export interface ProposedGoal {
  objective: string;
  target_metric: MeasurableMetric;
  target_value: number;
  rationale: string;
}

export type ProposeModel = (prompt: string) => Promise<string>;

export function buildProposerPrompt(companyBrain: string): string {
  return `You are proposing ONE measurable 30-day goal for a company, to seed its autopilot. The founder will review and confirm or change it — so propose the single most obvious, defensible growth goal from what the company does.

WHAT THE COMPANY IS (its brain):
${companyBrain.slice(0, 3000)}

Rules:
- target_metric MUST be exactly one of: ${MEASURABLE_METRICS.join(", ")}. These are the only metrics the system can actually measure. Pick the one that best fits this company's model (a marketplace/booking business → bookings; a signup-led product → signups; a checkout/commerce business → purchases; an engagement product → activations or key_actions).
- target_value: a specific, plausible 30-day number for a company at early scale. Not zero, not absurd.
- objective: one sentence a founder would recognize as theirs.
- rationale: one sentence on why this metric fits THIS company.

Respond with ONLY JSON, no prose:
{"objective":"...","target_metric":"<one of the allowed>","target_value":<number>,"rationale":"..."}`;
}

export function parseProposal(raw: string): ProposedGoal | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const metric = o.target_metric;
  if (typeof metric !== "string" || !(MEASURABLE_METRICS as readonly string[]).includes(metric)) return null;
  const value = typeof o.target_value === "number" ? o.target_value : Number(o.target_value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const objective = typeof o.objective === "string" ? o.objective.trim() : "";
  if (!objective) return null;
  return {
    objective: objective.slice(0, 500),
    target_metric: metric as MeasurableMetric,
    target_value: value,
    rationale: (typeof o.rationale === "string" ? o.rationale : "").slice(0, 500),
  };
}

export async function proposeGoalWith(companyBrain: string, model: ProposeModel): Promise<ProposedGoal | null> {
  if (!companyBrain.trim()) return null;
  let raw: string;
  try {
    raw = await model(buildProposerPrompt(companyBrain));
  } catch {
    return null;
  }
  return parseProposal(raw);
}

export const claudeProposer: ProposeModel = async (prompt: string) => {
  const res = await callModel({
    provider: "anthropic",
    model: MODELS.anthropic.haiku,
    system: "You propose a single measurable business goal as strict JSON. You never invent a metric outside the allowed list.",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
    temperature: 0.2,
    maxAttempts: 2,
  });
  return res.text;
};

export function proposeGoal(companyBrain: string): Promise<ProposedGoal | null> {
  return proposeGoalWith(companyBrain, claudeProposer);
}
