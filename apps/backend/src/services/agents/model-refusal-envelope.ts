
import { asRefusalReasonCode, type RefusalReasonCode } from "./outcome-model";

export function isModelRefusalEnvelope(inner: unknown): boolean {
  if (!inner || typeof inner !== "object") return false;
  const r = inner as { refused?: unknown; rendered_markdown?: unknown; customer_summary?: unknown };
  if (r.refused !== true) return false;
  const hasText =
    (typeof r.rendered_markdown === "string" && r.rendered_markdown.trim().length > 0) ||
    (typeof r.customer_summary === "string" && r.customer_summary.trim().length > 0);
  return hasText;
}

export function modelRefusalParsed(inner: unknown): Record<string, unknown> {
  const r = (inner ?? {}) as {
    rendered_markdown?: unknown;
    customer_summary?: unknown;
    reason_code?: unknown;
  };
  const summary = typeof r.customer_summary === "string" ? r.customer_summary.trim() : "";
  const markdown =
    typeof r.rendered_markdown === "string" && r.rendered_markdown.trim().length > 0
      ? r.rendered_markdown
      : summary;
  const code = asRefusalReasonCode(r.reason_code);
  return {
    rendered_markdown: markdown,
    refused: true,
    parse_fallback_kind: "model_refusal",
    ...(code ? { reason_code: code } : {}),
    ...(summary ? { customer_summary: summary } : {}),
  };
}

export function normalizeNoChangeDecision(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const p = parsed as { reason_code?: unknown; refused?: unknown; customer_summary?: unknown };
  if (p.reason_code !== "no_change" || p.refused === true) return parsed;
  if (typeof p.customer_summary !== "string" || p.customer_summary.trim().length === 0) return parsed;
  return modelRefusalParsed(parsed);
}

const CUSTOMER_SUMMARY_MAX = 600;

export function readCustomerFacingFields(parsed: unknown): {
  customer_summary?: string;
  reason_code?: RefusalReasonCode;
} {
  if (!parsed || typeof parsed !== "object") return {};
  const p = parsed as { customer_summary?: unknown; reason_code?: unknown };
  const out: { customer_summary?: string; reason_code?: RefusalReasonCode } = {};
  if (typeof p.customer_summary === "string" && p.customer_summary.trim().length > 0) {
    out.customer_summary = p.customer_summary.trim().slice(0, CUSTOMER_SUMMARY_MAX);
  }
  const code = asRefusalReasonCode(p.reason_code);
  if (code) out.reason_code = code;
  return out;
}
