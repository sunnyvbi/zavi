import { hasAnthropicAuth } from "@/services/anthropic";
import { apiComplete, type EnrichmentComplete } from "./text-model";
import { z } from "zod";

export const COMPANY_SHAPES = [
  "marketplace",
  "saas",
  "ecommerce",
  "services",
  "fintech",
  "other",
] as const;
export type CompanyShape = (typeof COMPANY_SHAPES)[number];
const SHAPE_SET = new Set<string>(COMPANY_SHAPES);

const STAGE_MIN = 0;
const STAGE_MAX = 6;

const MIN_CONTEXT_CHARS = 200;

export type ShapeStageResult = {
  shape: CompanyShape;
  stage: number;
  confidence: "high" | "low";
};

const FALLBACK: ShapeStageResult = { shape: "other", stage: STAGE_MIN, confidence: "low" };

const ClassifyLlmSchema = z.object({
  shape: z.string(),
  stage: z.union([z.number(), z.string()]),
  confidence: z.string().optional(),
});

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function normalize(parsed: z.infer<typeof ClassifyLlmSchema>): ShapeStageResult {
  const rawShape = String(parsed.shape).toLowerCase().trim();
  const shapeInSet = SHAPE_SET.has(rawShape);
  const shape: CompanyShape = shapeInSet ? (rawShape as CompanyShape) : "other";

  const stageNum = Number(parsed.stage);
  const stage = Number.isFinite(stageNum)
    ? Math.min(STAGE_MAX, Math.max(STAGE_MIN, Math.round(stageNum)))
    : STAGE_MIN;

  const said = String(parsed.confidence ?? "").toLowerCase().trim();
  const confidence: "high" | "low" = shapeInSet && said === "high" ? "high" : "low";

  return { shape, stage, confidence };
}

export function extractClassification(raw: string): ShapeStageResult | null {
  const candidates: string[] = [];
  const tag = raw.match(/<classification_json>([\s\S]*?)<\/classification_json>/);
  if (tag) candidates.push(stripJsonFence(tag[1]));
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const keyed = raw.match(/\{[^{}]*"shape"[^{}]*\}/);
  if (keyed) candidates.push(keyed[0]);
  const bare = raw.match(/\{[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);

  for (const candidate of candidates) {
    try {
      return normalize(ClassifyLlmSchema.parse(JSON.parse(candidate)));
    } catch {
    }
  }
  return null;
}

export async function classifyShapeStage(enrichmentText: string, complete?: EnrichmentComplete): Promise<ShapeStageResult> {
  if (!complete && !hasAnthropicAuth()) return FALLBACK;
  if ((enrichmentText ?? "").trim().length < MIN_CONTEXT_CHARS) return FALLBACK;

  const system = `You classify a company's TYPE and lifecycle STAGE from its own website content, for an onboarding form.

Return only a JSON object inside <classification_json> tags.

shape — pick the SINGLE best fit from this closed set (use the exact string):
- "marketplace": a two-sided platform connecting distinct buyers/sellers, hosts/guests, or supply/demand (P2P, B2C, or B2B).
- "saas": subscription / seat-based / usage-billed software the customer logs into.
- "ecommerce": sells physical or digital goods directly (D2C brand, retail, store).
- "services": agency, consulting, on-demand or done-for-you human services.
- "fintech": lending, payments, payouts, neobank, or other regulated money movement.
- "other": none of the above clearly fits.

stage — an INTEGER 0..6 for how far along the company is, where 0=pre-launch (no live product), 1=soft-launch / private beta, 2=live but very early / single market, 3=live and established in one market, 4=multi-market / scaling, 5=national, 6=international / global. If the text does not clearly indicate maturity, choose 0.

confidence — "high" only if the text clearly and unambiguously supports the shape; otherwise "low".

Rules:
1. Ground EVERY choice in the provided content. Do NOT guess from the company name alone.
2. If the content is thin, generic, or ambiguous, return your best-guess shape with "low" confidence and stage 0.
3. Never invent a shape outside the closed set above.`;

  const user = `Website content:
${enrichmentText.slice(0, 8000)}

Return: <classification_json>{"shape":"...","stage":0,"confidence":"low"}</classification_json>`;

  try {
    const raw = await (complete ?? apiComplete)({ system, user, maxTokens: 120, timeoutMs: 30_000 });
    return extractClassification(raw) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
