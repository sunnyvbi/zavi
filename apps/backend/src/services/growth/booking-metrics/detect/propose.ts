
import { serviceClient } from "@/services/supabase";
import { withReadSession, visibleCatalog } from "@/services/data-gateway";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { sampleMongoSketches } from "./sample-mongo";
import { sampleSqlSketches, type SampleOutcome } from "./sample-sql";
import { detectBookingMapping } from "./detect";
import { verifyMapping, type VerifiedMapping } from "./verify";
import { getBookingMetricConfig, type BookingEngine } from "../config";

export type ProposeResult = { mapping: VerifiedMapping; wrote: boolean; skipped?: string[] } | null;

export async function detectAndProposeBookingMapping(
  tenant_id: string,
  opts?: { provider?: "anthropic" | "openai"; model?: string; timeoutMs?: number },
): Promise<ProposeResult> {
  const existing = await getBookingMetricConfig(tenant_id);
  if (existing?.state === "confirmed") return null;

  let engine: BookingEngine;
  let outcome: SampleOutcome;
  try {
    const r = await withReadSession({ tenant_id, caller: { kind: "background", feature: "Booking setup check" } }, async (session, access) => {
      const type = access.dialect;
      if (type !== "mongodb" && type !== "postgres" && type !== "mysql") return null;
      const visible = visibleCatalog(access.catalog.catalog, access.policy);
      const out = type === "mongodb" ? await sampleMongoSketches(session.mongo(), visible) : await sampleSqlSketches(session, visible, type);
      return { engine: type as BookingEngine, outcome: out };
    });
    if (!r) return null;
    engine = r.engine;
    outcome = r.outcome;
  } catch (e) {
    if (e instanceof ExpectedToolError) return null;
    throw e;
  }
  if (outcome.skipped.length) {
    await logEvent({
      level: "info",
      source: "booking_metrics.detect",
      code: "sample_skipped",
      tenant_id,
      message: `skipped: ${outcome.skipped.join("; ")}`.slice(0, 400),
    });
  }
  const sketches = outcome.sketches;
  if (sketches.length === 0) return null;

  const detected = await detectBookingMapping(sketches, { tenantId: tenant_id, ...opts });
  if (!detected || !detected.booking_source || !detected.date_field) return null;

  const mapping = verifyMapping(detected, sketches);

  const { error } = await serviceClient().rpc("propose_booking_metric_config", {
    p_tenant_id: tenant_id,
    p_engine: engine,
    p_booking_source: mapping.booking_source,
    p_date_field: mapping.date_field,
    p_status_field: mapping.status_field,
    p_completed_statuses: mapping.completed_statuses,
    p_revenue_field: mapping.revenue_field,
    p_refund_field: mapping.refund_field,
    p_refund_basis: mapping.refund_field ? "booking_created_net" : "none",
    p_currency: mapping.currency,
    p_reporting_timezone: "UTC",
    p_amount_unit: mapping.amount_unit === "cents" ? "cents" : "dollars",
  });

  return { mapping, wrote: !error, ...(outcome.skipped.length ? { skipped: outcome.skipped } : {}) };
}
