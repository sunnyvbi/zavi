
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER, MODELS } from "@/services/llm/models";
import type { CollectionSketch } from "./sample-mongo";

const DETECT_MODEL = MODELS.anthropic.sonnet;

export type DetectedMapping = {
  booking_source: string | null;
  date_field: string | null;
  status_field: string | null;
  completed_statuses: string[];
  revenue_field: string | null;
  amount_unit: "dollars" | "cents" | "unknown";
  refund_field: string | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  blockers: string[];
  reasoning: string;
};

const SYSTEM = [
  "You identify how a marketplace/company operator's database records COMPLETED, REVENUE-GENERATING TRANSACTIONS,",
  "so we can chart real bookings/day and revenue/day. The business could be ANY shape: rides, rentals, food orders,",
  "reservations, appointments, e-commerce orders, services, etc. Do NOT assume 'trips' or 'bookings' naming.",
  "",
  "You are given VALUE SKETCHES of candidate collections: field names, observed types, real EXAMPLE VALUES, numeric",
  "ranges, and low-cardinality string fields with their value distributions (status candidates).",
  "",
  "RULES:",
  "- Names are hints only. EVERY choice must be justified by the sample VALUES/STATS, not the field name.",
  "- booking_source: the collection representing the primary completed customer transaction (the thing ads drive).",
  "- date_field: a DATE-typed field representing when the transaction was created/placed (not a photo/updated/misc timestamp).",
  "- status_field + completed_statuses: pick the status field and the SUBSET of its real values that mean completed/",
  "  successful/paid (exclude cancelled/refunded/failed/pending). Use the actual values shown.",
  "- revenue_field: the numeric field whose values look like a realistic per-transaction TOTAL the customer paid.",
  "  Reject ids, counts, ratings, quantities, distances, epoch timestamps, deposits/fees/taxes-only. If none is clearly",
  "  the total, set revenue_field=null (we show count-only — that is SAFE, better than a wrong number).",
  "- amount_unit: 'cents' if magnitudes look like integer minor units (e.g. 4999 for $49.99), 'dollars' if decimal",
  "  dollar-scale, else 'unknown'.",
  "- refund_field: a per-transaction refunded-amount field if present, else null.",
  "- currency: ISO code only if determinable from a field; else null.",
  "- blockers: list anything that should force human confirm — amount is nested/on another collection, cents/dollars",
  "  ambiguous, multiple currencies, gross-vs-net unclear, per-line-item not per-order, weak status signal.",
  "- confidence: high only if source+date+status+revenue are all clearly value-justified with no blockers.",
  "",
  "Output STRICT JSON ONLY, no prose outside it, matching exactly:",
  '{"booking_source":"","date_field":"","status_field":"","completed_statuses":[],"revenue_field":null,',
  '"amount_unit":"unknown","refund_field":null,"currency":null,"confidence":"low","blockers":[],"reasoning":""}',
].join("\n");

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function detectBookingMapping(
  sketches: CollectionSketch[],
  opts?: {
    tenantId?: string | null;
    timeoutMs?: number;
    provider?: "anthropic" | "openai";
    model?: string;
  },
): Promise<DetectedMapping | null> {
  if (sketches.length === 0) return null;
  const resp = await callModel({
    provider: opts?.provider ?? DEFAULT_PROVIDER,
    model: opts?.model ?? DETECT_MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: `Candidate collections (value sketches):\n${JSON.stringify(sketches, null, 1)}` }],
    timeoutMs: opts?.timeoutMs ?? 40_000,
    tags: { tenantId: opts?.tenantId ?? null, agentSlug: "booking-mapping-detect" },
  });
  const parsed = extractJson(resp.text.trim());
  if (!parsed) return null;

  const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const unit = asStr(parsed.amount_unit);
  const conf = asStr(parsed.confidence);
  return {
    booking_source: asStr(parsed.booking_source),
    date_field: asStr(parsed.date_field),
    status_field: asStr(parsed.status_field),
    completed_statuses: Array.isArray(parsed.completed_statuses)
      ? parsed.completed_statuses.filter((x): x is string => typeof x === "string")
      : [],
    revenue_field: asStr(parsed.revenue_field),
    amount_unit: unit === "cents" || unit === "dollars" ? unit : "unknown",
    refund_field: asStr(parsed.refund_field),
    currency: asStr(parsed.currency),
    confidence: conf === "high" || conf === "medium" ? conf : "low",
    blockers: Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((x): x is string => typeof x === "string")
      : [],
    reasoning: asStr(parsed.reasoning) ?? "",
  };
}
