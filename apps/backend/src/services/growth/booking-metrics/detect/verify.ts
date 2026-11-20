
import type { CollectionSketch, FieldSketch } from "./sample-mongo";
import type { DetectedMapping } from "./detect";

const MIN_TXN = 0.5;
const MAX_TXN = 1_000_000;
const MIN_NONZERO_FRAC = 0.5;

export type VerifiedMapping = DetectedMapping & {
  verification: {
    revenue_ok: boolean;
    downgrades: string[];
    needs_confirm_reasons: string[];
  };
};

function findField(sketch: CollectionSketch | undefined, path: string | null): FieldSketch | undefined {
  if (!sketch || !path) return undefined;
  return sketch.fields.find((f) => f.path === path);
}

export function verifyMapping(
  mapping: DetectedMapping,
  sketches: CollectionSketch[],
): VerifiedMapping {
  const sketch = sketches.find((s) => s.collection === mapping.booking_source);
  const downgrades: string[] = [];
  const needs_confirm_reasons: string[] = [...mapping.blockers];

  let revenue_field = mapping.revenue_field;
  let currency = mapping.currency;
  let amount_unit: "dollars" | "cents" = mapping.amount_unit === "cents" ? "cents" : "dollars";

  if (revenue_field) {
    const f = findField(sketch, revenue_field);
    if (!f || !f.numeric_stats) {
      downgrades.push(`revenue field '${revenue_field}' has no numeric samples`);
      revenue_field = null;
    } else {
      const { min, max, nonzero_frac } = f.numeric_stats;
      if (nonzero_frac < MIN_NONZERO_FRAC) {
        downgrades.push(
          `revenue field '${revenue_field}' is zero on ${Math.round((1 - nonzero_frac) * 100)}% of sampled rows`,
        );
        revenue_field = null;
      } else if (max < MIN_TXN || min > MAX_TXN) {
        downgrades.push(
          `revenue field '${revenue_field}' magnitude (${min}..${max}) is outside a plausible per-transaction range`,
        );
        revenue_field = null;
      } else if (
        mapping.amount_unit === "cents" ||
        (mapping.amount_unit === "unknown" && min >= 1000 && Number.isInteger(min) && Number.isInteger(max))
      ) {
        amount_unit = "cents";
        needs_confirm_reasons.push(
          `revenue field '${revenue_field}' looks like cents/minor-units (magnitude ${min}..${max}) — confirm it is in cents (we divide by 100) or switch it to dollars`,
        );
      }
    }
  }

  if (revenue_field && !currency) {
    needs_confirm_reasons.push("currency not detected — confirm before computing MER");
  }

  if (mapping.status_field && mapping.completed_statuses.length === 0) {
    needs_confirm_reasons.push(
      `status field '${mapping.status_field}' detected but no completed-status values chosen — confirm which count`,
    );
  }

  return {
    ...mapping,
    revenue_field,
    amount_unit,
    currency: revenue_field ? currency : null,
    verification: {
      revenue_ok: revenue_field !== null,
      downgrades,
      needs_confirm_reasons: [...new Set(needs_confirm_reasons)],
    },
  };
}
