
import type { NormalizedPageContext } from "./page-context";
import { SUPPORTED_ADAPTER_IDS } from "./page-context";
import { logReview } from "@/services/logging/log-review";

export const DETECTED_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "cpa",
  "roas",
] as const;

export type DetectedField = (typeof DETECTED_FIELDS)[number];

export type AdapterId = (typeof SUPPORTED_ADAPTER_IDS)[number];

export type AdapterHealthOutcome = "empty_or_broken" | "unmapped_or_absent";

export type AdapterHealthFinding =
  | {
      kind: "zero_rows";
      outcome: "empty_or_broken";
      adapter_id: AdapterId;
      row_count_total: number;
    }
  | {
      kind: "field_all_null";
      outcome: "unmapped_or_absent";
      adapter_id: AdapterId;
      field: DetectedField;
      rows_present: number;
    };

function asAdapterId(value: string | null): AdapterId | null {
  return (SUPPORTED_ADAPTER_IDS as readonly string[]).includes(value ?? "")
    ? (value as AdapterId)
    : null;
}

export function detectAdapterBreakage(
  ctx: NormalizedPageContext,
): AdapterHealthFinding[] {
  const adapter_id = asAdapterId(ctx.adapter_id);
  const extraction = ctx.extraction;

  if (ctx.observation_only || !extraction || adapter_id === null) return [];

  if (extraction.truncated) return [];

  const rows = extraction.rows;

  if (rows.length === 0) {
    return [
      {
        kind: "zero_rows",
        outcome: "empty_or_broken",
        adapter_id,
        row_count_total: extraction.row_count_total,
      },
    ];
  }

  const findings: AdapterHealthFinding[] = [];
  for (const field of DETECTED_FIELDS) {
    if (rows.every((r) => r[field] === null)) {
      findings.push({
        kind: "field_all_null",
        outcome: "unmapped_or_absent",
        adapter_id,
        field,
        rows_present: rows.length,
      });
    }
  }
  return findings;
}

export function recordAdapterHealth(args: {
  ctx: NormalizedPageContext;
  run_id: string;
  tenant_id: string;
}): void {
  try {
    for (const finding of detectAdapterBreakage(args.ctx)) {
      const meta: Record<string, DetectedField | AdapterId | number> = {
        adapter_id: finding.adapter_id,
      };
      if (finding.kind === "zero_rows") {
        meta.row_count_total = finding.row_count_total;
        meta.rows_present = 0;
      } else {
        meta.null_field = finding.field;
        meta.rows_present = finding.rows_present;
      }
      logReview({
        feature: "extension_adapter",
        event: finding.kind,
        outcome: finding.outcome,
        run_id: args.run_id,
        tenant_id: args.tenant_id,
        meta,
      });
    }
  } catch (e) {
    try {
      console.warn(
        `[page-context-health] detector suppressed: ${(e as Error)?.message ?? "unknown"}`,
      );
    } catch {
    }
  }
}
