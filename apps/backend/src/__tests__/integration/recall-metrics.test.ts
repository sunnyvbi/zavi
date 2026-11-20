import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computeRecallMetric, type RecallMetricRow } from "@/services/memory/recall-metrics";
import type { Golden } from "@/services/memory/recall-eval";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";
const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_AGENT = "recall-metrics-itest-agent";
const RUN_DATE = "2026-01-02";

const GOLDENS: Golden[] = [
  { id: "ig1", tenant_id: TENANT_ID, query: "iq1", expected_note_ids: ["in1"], agent_slug: TEST_AGENT },
  { id: "ig2", tenant_id: TENANT_ID, query: "iq2", expected_note_ids: ["in2"], agent_slug: TEST_AGENT },
  { id: "ig3", tenant_id: TENANT_ID, query: "iq3", expected_note_ids: ["in3"], agent_slug: TEST_AGENT },
];
const SEARCH_MAP: Record<string, string[]> = {
  iq1: ["in1"],
  iq2: ["in2"],
  iq3: ["miss"],
};

describe.skipIf(!isIntegration)("memory_recall_metrics writer (integration)", () => {
  beforeAll(async () => {
    await sb!.from("memory_recall_metrics").delete().eq("agent_slug", TEST_AGENT);
  });

  afterAll(async () => {
    await sb!.from("memory_recall_metrics").delete().eq("agent_slug", TEST_AGENT);
  });

  it("computes + upserts one (agent_slug, run_date) row with a numeric rate in [0,1]", async () => {
    const result: RecallMetricRow = await computeRecallMetric(
      TEST_AGENT,
      {
        loadGoldensForAgent: async () => GOLDENS,
        search: async (_t, query) => (SEARCH_MAP[query] ?? []).map((note_id) => ({ note_id })),
        verifyTenantNotes: async (_t, ids) => new Set(ids),
        upsertMetric: async (row) => {
          const { error } = await sb!.from("memory_recall_metrics").upsert(
            {
              agent_slug: row.agent_slug,
              run_date: row.run_date,
              clean_grounded_rate: row.clean_grounded_rate,
              sample_size: row.sample_size,
              computed_at: new Date().toISOString(),
            },
            { onConflict: "agent_slug,run_date" },
          );
          if (error) throw new Error(`upsert failed: ${error.message}`);
        },
      },
      RUN_DATE,
    );

    expect(result.sample_size).toBe(3);
    expect(result.clean_grounded_rate).toBeCloseTo(0.6667, 3);

    const { data, error } = await sb!
      .from("memory_recall_metrics")
      .select("clean_grounded_rate, sample_size")
      .eq("agent_slug", TEST_AGENT)
      .eq("run_date", RUN_DATE);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const rate = Number(data![0].clean_grounded_rate);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
    expect(rate).toBeCloseTo(0.6667, 3);
    expect(data![0].sample_size).toBe(3);
  });

  it("re-running the same (agent_slug, run_date) upserts (idempotent, no PK violation)", async () => {
    const run = () =>
      computeRecallMetric(
        TEST_AGENT,
        {
          loadGoldensForAgent: async () => GOLDENS,
          search: async (_t, query) => (SEARCH_MAP[query] ?? []).map((note_id) => ({ note_id })),
          verifyTenantNotes: async (_t, ids) => new Set(ids),
          upsertMetric: async (row) => {
            const { error } = await sb!.from("memory_recall_metrics").upsert(
              {
                agent_slug: row.agent_slug,
                run_date: row.run_date,
                clean_grounded_rate: row.clean_grounded_rate,
                sample_size: row.sample_size,
                computed_at: new Date().toISOString(),
              },
              { onConflict: "agent_slug,run_date" },
            );
            if (error) throw new Error(`upsert failed: ${error.message}`);
          },
        },
        RUN_DATE,
      );
    await run();
    await run();
    const { data } = await sb!
      .from("memory_recall_metrics")
      .select("agent_slug")
      .eq("agent_slug", TEST_AGENT)
      .eq("run_date", RUN_DATE);
    expect(data).toHaveLength(1);
  });
});
