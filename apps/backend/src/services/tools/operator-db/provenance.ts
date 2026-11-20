
import { serviceClient } from "@/services/supabase";
import type { MetricResult } from "./metric-contract";

export async function recordProvenance(
  tenantId: string,
  runId: string,
  metric: MetricResult,
  windowStart: string,
  windowEnd: string,
): Promise<void> {
  try {
    await serviceClient().rpc("record_diagnosis_provenance", {
      p_tenant_id: tenantId,
      p_run_id: runId,
      p_query_id: metric.query_id,
      p_source: metric.source,
      p_window_start: windowStart,
      p_window_end: windowEnd,
      p_numerator: metric.numerator,
      p_denominator: metric.denominator,
      p_row_count: metric.sampled_count ?? metric.denominator,
      p_truncated: false,
    });
  } catch {
  }
}
