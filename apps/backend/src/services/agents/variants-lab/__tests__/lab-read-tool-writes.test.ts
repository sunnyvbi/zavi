
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordProvenance = vi.fn(async () => {});
vi.mock("@/services/tools/operator-db/provenance", () => ({
  recordProvenance: (...a: unknown[]) => recordProvenance(...(a as [])),
}));
vi.mock("@/services/data-gateway", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadDbAccess: async () => ({ config: { type: "mongodb" }, connectionString: "x", policy: {} }),
  visibleCatalog: (c: unknown) => c,
}));
vi.mock("@/services/tools/operator-db/catalog", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCatalog: async () => ({
    dialect: "mongodb",
    catalog: { tables: [] },
    hints: {},
    catalog_hash: "hash-abc",
    discovery_error: null,
    updated_at: null,
  }),
}));
vi.mock("@/services/tools/operator-db/mapping", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfirmedMapping: async () => ({
    catalog_hash: "hash-abc",
    confirmed_at: "2026-07-04T00:00:00Z",
    confirmed_map: {
      bookings: { table: "bookings", label: "B", created_at_field: "created_at" },
      cancellations: { table: "bookings", label: "C", reason_field: "cancel_reason" },
    },
  }),
}));
vi.mock("@/services/mcp/internal/operator-db", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  callOperatorDbTool: async () => ({
    ok: true,
    is_error: false,
    ms: 1,
    content: JSON.stringify({
      ok: true,
      data: {
        collection: "bookings",
        row_count: 1,
        truncated: false,
        rows: [{ created_at: "2026-06-01T00:00:00Z", cancel_reason: "verification_failed" }],
      },
    }),
  }),
}));
vi.mock("@/services/tools/operator-db/metric-runner", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeMongoRunner: () => ({}),
}));
vi.mock("@/services/tools/operator-db/compute", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  computeLevers: async () => ({
    candidates: [
      {
        constraint: "idle-supply",
        numerator: 30,
        denominator: 100,
        source_quality: "confirmed_live_mongo",
        confirmed_map: true,
        metric_probe_passed: true,
        k_anon_passed: true,
        live_validated: true,
        query_id: "idle-supply:listings-vs-booked",
        elasticity_hint: "hint",
        build_cost_hint: "low",
      },
    ],
    metrics: [
      {
        lever: "idle-supply",
        result: {
          lever: "idle-supply",
          numerator: 30,
          denominator: 100,
          window_days: 30,
          numerator_window_days: 30,
          denominator_window_days: 30,
          query_id: "idle-supply:listings-vs-booked",
          source: "listings+bookings",
        },
      },
    ],
  }),
}));

const cacheSiteAuditRun = vi.fn(async () => {});
vi.mock("@/services/tools/growth/seo/snapshot", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  cacheSiteAuditRun: (...a: unknown[]) => cacheSiteAuditRun(...(a as [])),
  cacheSeoAuditFailure: async () => {},
}));
vi.mock("@/services/tools/growth/seo/run", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runSiteAudit: async () => ({}),
  seoShapeOf: () => ({ pages_analyzed: 1, findings: [] }),
}));

const tiktokUpdate = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    tenantClient: (t: string) => ({
      from: (table: string) =>
        table === "tiktok_scheduled_posts"
          ? {
              select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { publish_id: "p1" } }) }) }),
              update: tiktokUpdate,
            }
          : (real.tenantClient as (t: string) => { from: (x: string) => unknown })(t).from(table),
    }),
  };
});
vi.mock("@/services/connectors/tiktok/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchTikTokPostStatus: async () => ({ data: { status: "PUBLISH_COMPLETE" } }),
}));

import { callMcpTool } from "@/services/mcp/execute";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const POST = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read tools with a write, through callMcpTool", () => {
  it("growth_constraint_diagnosis: no provenance when writes are suppressed", async () => {
    const r = await callMcpTool({ tenant_id: T, run_id: "r1", writes_suppressed: true }, "growth", "constraint_diagnosis", {});
    expect(r.is_error).toBe(false);
    expect(JSON.parse(r.content).status).toBe("diagnosed");
    expect(recordProvenance).not.toHaveBeenCalled();
    await callMcpTool({ tenant_id: T, run_id: "r1" }, "growth", "constraint_diagnosis", {});
    expect(recordProvenance).toHaveBeenCalledTimes(1);
  });

  it("growth_seo_audit: no snapshot cache write when writes are suppressed", async () => {
    const r = await callMcpTool({ tenant_id: T, run_id: "r2", writes_suppressed: true }, "growth", "seo_audit", {});
    expect(r.is_error).toBe(false);
    expect(cacheSiteAuditRun).not.toHaveBeenCalled();
    await callMcpTool({ tenant_id: T, run_id: "r2" }, "growth", "seo_audit", {});
    expect(cacheSiteAuditRun).toHaveBeenCalledTimes(1);
  });

  it("tiktok_get_post_status: no status persist when writes are suppressed", async () => {
    const r = await callMcpTool({ tenant_id: T, run_id: "r3", writes_suppressed: true }, "tiktok", "get_post_status", { post_id: POST });
    expect(r.is_error).toBe(false);
    expect(tiktokUpdate).not.toHaveBeenCalled();
    await callMcpTool({ tenant_id: T, run_id: "r3" }, "tiktok", "get_post_status", { post_id: POST });
    expect(tiktokUpdate).toHaveBeenCalledTimes(1);
  });
});
