
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { loadDbAccess } from "@/services/data-gateway";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import {
  getConfirmedMapping,
  proposedCanonicalMap,
  type CanonicalMap,
} from "@/services/tools/operator-db/mapping";
import { probeMappedFields, type FieldProbe, type TableSampler } from "@/services/tools/operator-db/probes";
import { computeLevers } from "@/services/tools/operator-db/compute";
import { makeMongoRunner } from "@/services/tools/operator-db/metric-runner";
import { rankLevers } from "@/services/tools/operator-db/ranking";
import { recordProvenance } from "@/services/tools/operator-db/provenance";

const inputSchema = z.object({
  window_days: z.number().int().min(1).max(365).optional(),
});

const SAMPLE_LIMIT = 50;

const FALSE_ZERO_LEVERS = [
  "idle-supply",
  "verification-cancel-leak",
  "thin-funnel",
  "attempt-to-conversion",
] as const;

function makeSampler(tenantId: string, caller: { run_id?: string | null; agent_slug?: string | null } = {}): TableSampler {
  return async (table: string) => {
    const res = await callOperatorDbTool(tenantId, "query", {
      collection: table,
      mode: "find",
      limit: SAMPLE_LIMIT,
    }, caller);
    if (!res.ok || res.is_error) return null;
    try {
      const parsed = JSON.parse(res.content) as {
        data?: { rows?: Record<string, unknown>[] };
        rows?: Record<string, unknown>[];
      };
      const rows = parsed?.data?.rows ?? parsed?.rows;
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  };
}

function hasBlockingProbeFailure(probes: FieldProbe[]): boolean {
  return probes.some((p) => !p.ok && (p.kind === "date" || p.kind === "numeric"));
}

function probesRan(probes: FieldProbe[]): boolean {
  return probes.some((p) => p.reason !== "sample_unavailable");
}

export const growthConstraintDiagnosisTool: ToolSpec = {
  name: "growth_constraint_diagnosis",
  effect: "read",
  description:
    "Diagnose which growth lever is BINDING for this tenant, grounded in their connected operator DB, with every number query-traced or [no data]. Read-only. This is the ONLY path that may emit a rankable constraint number — do not infer constraints from raw operator_db_query results. On first run (or after a schema change) it returns `requires_mapping_confirmation` with a proposed table/field map for the operator to confirm or correct; no numbers are emitted until the map is confirmed. Field-level sanity probes flag a mapping that looks wrong (e.g. a date field with no real timestamps) so a mis-map surfaces as a warning, never a false zero.",
  input_schema: inputSchema,
  async execute(ctx, _input) {
    await loadDbAccess(ctx.tenant_id);

    const resolved = await getCatalog(ctx.tenant_id);
    const catalogHash = resolved?.catalog_hash ?? null;
    if (!resolved || !catalogHash) {
      return {
        status: "requires_mapping_confirmation" as const,
        catalog_hash: null,
        proposed_map: {},
        probes: [],
        message: "Operator DB schema is still being discovered. Retry shortly.",
      };
    }

    const confirmed = await getConfirmedMapping(ctx.tenant_id, catalogHash);
    const sampler = makeSampler(ctx.tenant_id, { run_id: ctx.run_id, agent_slug: ctx.agent_slug });

    if (!confirmed) {
      const proposed = proposedCanonicalMap(resolved.hints);
      const probes = await probeMappedFields(proposed, sampler);
      const cancelMapped = Boolean(
        proposed.cancellations?.table && proposed.cancellations?.reason_field,
      );
      const looksWrong = hasBlockingProbeFailure(probes);
      const ran = probesRan(probes);
      return {
        status: "requires_mapping_confirmation" as const,
        catalog_hash: catalogHash,
        proposed_map: proposed,
        probes,
        looks_wrong: looksWrong,
        probes_available: ran,
        cancel_leak_mappable: cancelMapped,
        message:
          "Confirm or correct this table/field mapping for your database, then re-run the diagnosis. " +
          (looksWrong
            ? "One or more mapped fields look wrong (see probes). Correct them before confirming."
            : ran
              ? "The proposed mapping passed the field-level sanity checks."
              : "Your data could not be sampled to sanity-check this mapping. Review it carefully before confirming."),
      };
    }

    const map: CanonicalMap = confirmed.confirmed_map ?? {};
    const probes = await probeMappedFields(map, sampler);

    if (hasBlockingProbeFailure(probes)) {
      return {
        status: "requires_mapping_confirmation" as const,
        catalog_hash: catalogHash,
        confirmed_at: confirmed.confirmed_at,
        probes,
        looks_wrong: true,
        probes_available: probesRan(probes),
        constraints: [] as unknown[],
        abstained: FALSE_ZERO_LEVERS.map((constraint) => ({ constraint, reason: "mapping_looks_wrong" })),
        message:
          "Your confirmed mapping now looks wrong — a mapped date/amount field failed the live sanity check (see probes). " +
          "No numbers were computed (a wrong field would produce a false zero). Correct the mapping and re-confirm.",
      };
    }

    const windowDays = inputSchema.parse(_input ?? {}).window_days ?? 30;
    const nowMs = Date.now();
    const runner = resolved.dialect === "mongodb" ? makeMongoRunner(ctx.tenant_id, { run_id: ctx.run_id, agent_slug: ctx.agent_slug }) : null;

    const { candidates, metrics } = await computeLevers(
      { map, dialect: resolved.dialect, window_days: windowDays, runner },
      nowMs,
    );
    const { ranked, abstained } = rankLevers(candidates);

    if (ctx.run_id && !ctx.writes_suppressed) {
      const windowStart = new Date(nowMs - windowDays * 86400000).toISOString();
      const windowEnd = new Date(nowMs).toISOString();
      for (const m of metrics) {
        await recordProvenance(ctx.tenant_id, ctx.run_id, m.result, windowStart, windowEnd);
      }
    }

    const constraints = ranked.map((r) => ({
      constraint: r.constraint,
      rank: r.rank,
      rate: r.rate,
      bucket_volume: r.bucket_volume,
      evidence: {
        numerator: r.numerator,
        denominator: r.denominator,
        source: r.source_quality,
        query_id: r.query_id ?? null,
      },
      elasticity_hint: r.elasticity_hint ?? null,
      build_cost_hint: r.build_cost_hint ?? null,
    }));

    return {
      status: "diagnosed" as const,
      catalog_hash: catalogHash,
      confirmed_at: confirmed.confirmed_at,
      window_days: windowDays,
      probes,
      looks_wrong: hasBlockingProbeFailure(probes),
      probes_available: probesRan(probes),
      constraints,
      abstained,
      note:
        ranked.length > 0
          ? "Ranked by measured volume × rate from your data. Elasticity / build-cost are labelled hints, not score inputs."
          : "No lever cleared the rankable gate (confirmed map + metric-contract probes + k-anon + live validation). See abstained[] for why.",
    };
  },
};
