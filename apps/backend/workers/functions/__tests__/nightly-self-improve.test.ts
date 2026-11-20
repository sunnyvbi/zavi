
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  isFleetHalted: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: mocks.isFleetHalted }));

import {
  runNightlySelfImprove,
  scopedRecentRunIds,
  loadRunForTenant,
  gradeRunForDigest,
  clusterizeTenantDigest,
  writeImprovementRows,
  NIGHTLY_SELF_IMPROVE_FLAG,
  type GradeableRunRow,
  type ImprovementCluster,
  type DigestItem,
} from "../nightly-self-improve";

const ORIG_ENV = process.env[NIGHTLY_SELF_IMPROVE_FLAG];

beforeEach(() => {
  mocks.serviceClient.mockReset();
  mocks.isFleetHalted.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env[NIGHTLY_SELF_IMPROVE_FLAG];
  else process.env[NIGHTLY_SELF_IMPROVE_FLAG] = ORIG_ENV;
});

describe("flag gate (ON by default; disable with 0/false)", () => {
  it("flag = '0' ⇒ enabled:false and ZERO serviceClient / settings / halt reads", async () => {
    process.env[NIGHTLY_SELF_IMPROVE_FLAG] = "0";

    const r = await runNightlySelfImprove();

    expect(r).toEqual({ enabled: false });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.isFleetHalted).not.toHaveBeenCalled();
  });

  it("flag = 'false' ⇒ also disabled", async () => {
    process.env[NIGHTLY_SELF_IMPROVE_FLAG] = "false";
    const r = await runNightlySelfImprove();
    expect(r).toEqual({ enabled: false });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it("flag UNSET ⇒ ENABLED by default (proceeds past the gate)", async () => {
    delete process.env[NIGHTLY_SELF_IMPROVE_FLAG];
    mocks.isFleetHalted.mockResolvedValue(true);
    const r = await runNightlySelfImprove();
    expect(r.enabled).toBe(true);
    expect(mocks.isFleetHalted).toHaveBeenCalled();
  });

  it("flag ON but fleet halted ⇒ enabled:true, halted, still no tenant scan", async () => {
    process.env[NIGHTLY_SELF_IMPROVE_FLAG] = "1";
    mocks.isFleetHalted.mockResolvedValue(true);

    const r = await runNightlySelfImprove();

    expect(r.enabled).toBe(true);
    expect(r.halted).toBe(true);
    expect(r.runs_graded).toBe(0);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});

describe("scopedRecentRunIds refuses a tenant-less read (contract 5)", () => {
  it("empty tenant_id ⇒ throws BEFORE any query is issued", async () => {
    await expect(
      scopedRecentRunIds({ tenant_id: "", agent_slug: "engineer", sinceIso: "x" }),
    ).rejects.toThrow(/tenant-less/);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it("whitespace-only tenant_id ⇒ throws, no query", async () => {
    await expect(
      scopedRecentRunIds({ tenant_id: "   ", agent_slug: "engineer", sinceIso: "x" }),
    ).rejects.toThrow(/tenant-less/);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it("valid tenant_id ⇒ query carries the explicit tenant filter", async () => {
    const eq = vi.fn();
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.eq = vi.fn((...args: unknown[]) => {
      eq(...args);
      return chain;
    });
    chain.limit = vi.fn(() => ({ data: [{ id: "r1" }], error: null }));
    mocks.serviceClient.mockReturnValue({ from: () => chain });

    const ids = await scopedRecentRunIds({
      tenant_id: "tenant-A",
      agent_slug: "engineer",
      sinceIso: "2026-06-06T00:00:00Z",
    });

    expect(ids).toEqual(["r1"]);
    expect(eq).toHaveBeenCalledWith("tenant_id", "tenant-A");
  });
});

describe("loadRunForTenant drops a cross-tenant run (C8 + contract 5)", () => {
  function mockSingle(row: unknown) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    mocks.serviceClient.mockReturnValue({ from: () => chain });
  }

  it("row tenant matches expected ⇒ run returned", async () => {
    mockSingle({
      id: "r1",
      tenant_id: "tenant-A",
      agent_slug: "engineer",
      status: "success",
      output_text: "ok",
      tool_calls: [],
      parsed: null,
    });
    const run = await loadRunForTenant("r1", "tenant-A");
    expect(run?.id).toBe("r1");
  });

  it("row belongs to ANOTHER tenant ⇒ DROPPED (null), never graded", async () => {
    mockSingle({
      id: "r1",
      tenant_id: "tenant-B",
      agent_slug: "engineer",
      status: "success",
      output_text: "ok",
      tool_calls: [],
      parsed: null,
    });
    const run = await loadRunForTenant("r1", "tenant-A");
    expect(run).toBeNull();
  });

  it("missing expectTenantId ⇒ throws (no tenant-less load)", async () => {
    await expect(loadRunForTenant("r1", "")).rejects.toThrow();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});

describe("gradeRunForDigest (pure) — surfaces only human-facing items", () => {
  const base: Omit<GradeableRunRow, "output_text" | "agent_slug"> = {
    id: "r1",
    tenant_id: "tenant-A",
    status: "success",
    tool_calls: [],
    parsed: null,
    quality_score: null,
    quality_rationale: null,
    quality_evidence: null,
    quality_scored_at: null,
  };

  it("money-path agent emits an UNGROUNDED $ number ⇒ E3 item", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "performance-marketer",
      output_text: "Recommend raising the budget to $500 per day.",
    });
    expect(items.some((i) => i.kind === "e3")).toBe(true);
  });

  it("non-money agent w/ an ungrounded $ number ⇒ NO ①C digest item (defer to ①A)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text: "Competitor pricing is around $500 per month.",
    });
    expect(items.some((i) => i.kind === "human_needed")).toBe(false);
    expect(items.some((i) => i.kind === "e3")).toBe(false);
    expect(items).toEqual([]);
  });

  it("research run with CITED magnitude-suffix $ figures ⇒ NO digest (the prod false-positive)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text:
        "US organized used-car market is ~$104.6B in 2026 [1]. Implied gross " +
        "transaction value is ~$950B–$1.1T (assumption, not directly sourced) [2].",
      tool_calls: [],
    });
    expect(items).toEqual([]);
  });

  it("non-money agent with all-prose / non-$ numbers ⇒ NO blocker (synthesis prose is the product)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text:
        "Cox Automotive forecasts 38.3M total US used vehicle sales in 2026 [1], " +
        "down about 0.9% year over year, with retail at 20.3M units [2].",
      tool_calls: [],
    });
    expect(items).toEqual([]);
  });

  it("money-path agent with all-prose / zero grounded atoms ⇒ STILL a blocker (regression guard)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "performance-marketer",
      output_text:
        "We reviewed the account broadly and everything looks generally fine overall.",
      tool_calls: [],
    });
    expect(items.some((i) => i.kind === "blocker")).toBe(true);
  });

  it("grounded number (in tool output) ⇒ no E3/human item from that number", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "performance-marketer",
      output_text: "Spend was $500 last week.",
      tool_calls: [
        {
          name: "meta_ads__spend",
          input_preview: "",
          output_preview: '{"total":"$500.00"}',
          ms: 1,
          status: "ok",
        } as unknown,
      ],
    });
    expect(items.some((i) => i.kind === "e3")).toBe(false);
  });

  it("clean grounded run ⇒ empty digest (lossy: no raw scores leaked)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "performance-marketer",
      output_text: "Spend was $500 last week.",
      tool_calls: [
        {
          name: "meta_ads__spend",
          input_preview: "",
          output_preview: '{"total":"$500.00"}',
          ms: 1,
          status: "ok",
        } as unknown,
      ],
    });
    expect(items).toEqual([]);
  });

  it("quality_score<50 + quality_evidence ⇒ false_negative_existence candidate (plan 2026-06-08)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "engineer",
      output_text: "I could not locate a host-review reply endpoint.",
      quality_score: 35,
      quality_rationale: "false_negative_existence",
      quality_evidence: {
        claimed_absent: "respondToCarReview",
        matched_symbol: "respondToCarReview",
        repo: "rravi149/upcar",
        path: "src/routes/cars.route.ts",
        line: 96,
        hit_type: "route",
        checked_ref: "HEAD",
      },
      quality_scored_at: new Date().toISOString(),
    });
    expect(items.some((i) => i.kind === "false_negative_existence")).toBe(true);
  });

  it("quality_score<50 but NO evidence ⇒ NOT false_negative_existence, but IS low_quality (the ①A wiring)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "engineer",
      output_text: "A short, low-quality answer.",
      quality_score: 30,
      quality_rationale: "thin",
      quality_evidence: null,
      quality_scored_at: new Date().toISOString(),
    });
    expect(items.some((i) => i.kind === "false_negative_existence")).toBe(false);
    expect(items.some((i) => i.kind === "low_quality")).toBe(true);
  });

  it("low quality_score on a THINKING agent ⇒ low_quality item (no neg-existence evidence needed)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text: "A verbose, ungrounded market summary.",
      quality_score: 22,
      quality_scored_at: new Date().toISOString(),
    });
    expect(items.some((i) => i.kind === "low_quality")).toBe(true);
  });

  it("a GOOD run (high quality_score) ⇒ NO low_quality item", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text: "A tight, well-cited report.",
      quality_score: 82,
      quality_scored_at: new Date().toISOString(),
    });
    expect(items).toEqual([]);
  });

  it("low_quality is STRICTLY below the bar (40 does NOT fire, 39 does)", () => {
    const at = new Date().toISOString();
    const atBar = gradeRunForDigest({
      ...base, agent_slug: "pm", output_text: "x".repeat(60),
      quality_score: 40, quality_scored_at: at,
    });
    expect(atBar.some((i) => i.kind === "low_quality")).toBe(false);
    const belowBar = gradeRunForDigest({
      ...base, agent_slug: "pm", output_text: "x".repeat(60),
      quality_score: 39, quality_scored_at: at,
    });
    expect(belowBar.some((i) => i.kind === "low_quality")).toBe(true);
  });

  it("an UNSCORED run (quality_score null) ⇒ no low_quality (never queues the unscored)", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "research",
      output_text: "Scored not yet / never-executed.",
      quality_score: null,
      quality_scored_at: null,
    });
    expect(items.some((i) => i.kind === "low_quality")).toBe(false);
  });

  it("neg-existence run (evidence + score<50) ⇒ false_negative_existence WINS, NOT double-queued as low_quality", () => {
    const items = gradeRunForDigest({
      ...base,
      agent_slug: "engineer",
      output_text: "I could not find a host-review reply endpoint.",
      quality_score: 30,
      quality_rationale: "false_negative_existence",
      quality_evidence: {
        claimed_absent: "respondToCarReview",
        matched_symbol: "respondToCarReview",
        repo: "rravi149/upcar",
        path: "src/routes/cars.route.ts",
        line: 96,
        hit_type: "route",
        checked_ref: "HEAD",
      },
      quality_scored_at: new Date().toISOString(),
    });
    expect(items.some((i) => i.kind === "false_negative_existence")).toBe(true);
    expect(items.some((i) => i.kind === "low_quality")).toBe(false);
  });
});

describe("clusterizeTenantDigest (pure) — actionable agents only", () => {
  const mkItem = (
    agent_slug: string,
    kind: DigestItem["kind"],
    run_id = "r1",
  ): DigestItem => ({
    tenant_id: "tenant-A",
    agent_slug,
    run_id,
    kind,
    reason: "x",
  });

  it("a below-bar agent (≥1 item) ⇒ exactly one cluster", () => {
    const clusters = clusterizeTenantDigest({
      tenant_id: "tenant-A",
      items: [mkItem("engineer", "human_needed")],
      gradedRunIdsByAgent: new Map([["engineer", ["r1", "r2"]]]),
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].agent_slug).toBe("engineer");
    expect(clusters[0].run_ids).toEqual(["r1", "r2"]);
  });

  it("a CLEAN-grade agent (zero items) ⇒ NO cluster (no row will be written)", () => {
    const clusters = clusterizeTenantDigest({
      tenant_id: "tenant-A",
      items: [],
      gradedRunIdsByAgent: new Map([["engineer", ["r1", "r2"]]]),
    });
    expect(clusters).toEqual([]);
  });

  it("cluster signature/reason are ENUM-ish (content-free) — NOT the item's free-text", () => {
    const clusters = clusterizeTenantDigest({
      tenant_id: "tenant-A",
      items: [mkItem("performance-marketer", "e3")],
      gradedRunIdsByAgent: new Map([["performance-marketer", ["r1"]]]),
    });
    expect(clusters[0].cluster_signature).toBe("e3");
    expect(clusters[0].digest_reason).toBe("money_path_ungrounded_number");
    expect(JSON.stringify(clusters[0])).not.toContain('"x"');
  });

  it("most-severe kind wins the signature (e3 > blocker > human_needed)", () => {
    const clusters = clusterizeTenantDigest({
      tenant_id: "tenant-A",
      items: [
        mkItem("operator", "human_needed"),
        mkItem("operator", "e3"),
        mkItem("operator", "blocker"),
      ],
      gradedRunIdsByAgent: new Map([["operator", ["r1"]]]),
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].cluster_signature).toBe("e3");
  });

  it("low_quality cluster ⇒ content-free digest_reason 'low_quality_score'", () => {
    const clusters = clusterizeTenantDigest({
      tenant_id: "tenant-A",
      items: [mkItem("research", "low_quality")],
      gradedRunIdsByAgent: new Map([["research", ["r1", "r2"]]]),
    });
    expect(clusters[0].cluster_signature).toBe("low_quality");
    expect(clusters[0].digest_reason).toBe("low_quality_score");
    expect(JSON.stringify(clusters[0])).not.toContain('"x"');
  });
});

describe("writeImprovementRows (the row-writer seam)", () => {
  function mockRpc(impl: (name: string, args: Record<string, unknown>) => unknown) {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => impl(name, args));
    mocks.serviceClient.mockReturnValue({ rpc });
    return rpc;
  }

  const cluster = (over: Partial<ImprovementCluster> = {}): ImprovementCluster => ({
    tenant_id: "tenant-A",
    agent_slug: "engineer",
    cluster_signature: "human_needed",
    run_ids: ["r1", "r2"],
    digest_reason: "ungrounded_number",
    ...over,
  });

  it("writes ONE row per cluster via create_improvement_request with the contract args", async () => {
    const rpc = mockRpc(() => ({ data: [{ request_id: 1, inserted: true }], error: null }));

    const written = await writeImprovementRows([cluster()], "nightly-2026-06-07");

    expect(written).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("create_improvement_request");
    expect(args.p_tenant_id).toBe("tenant-A");
    expect(args.p_agent_slug).toBe("engineer");
    expect(args.p_cluster_signature).toBe("human_needed");
    expect(args.p_run_ids).toEqual(["r1", "r2"]);
    expect(args.p_digest_reason).toBe("ungrounded_number");
    expect(args.p_window).toBe("nightly-2026-06-07");
  });

  it("CONTENT-FREE: the RPC payload carries NO raw prompt/output/diff", async () => {
    const rpc = mockRpc(() => ({ data: [{ request_id: 1, inserted: true }], error: null }));
    await writeImprovementRows([cluster()], "nightly-2026-06-07");
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "p_agent_slug",
      "p_cluster_signature",
      "p_digest_reason",
      "p_run_ids",
      "p_tenant_id",
      "p_window",
    ]);
  });

  it("IDEMPOTENT: ON CONFLICT (inserted:false) is NOT counted as a fresh write", async () => {
    mockRpc(() => ({ data: [{ request_id: 7, inserted: false }], error: null }));
    const written = await writeImprovementRows([cluster()], "nightly-2026-06-07");
    expect(written).toBe(0);
  });

  it("a cross-tenant HARD-reject (42501) from the RPC is SKIPPED, never aborts the fleet", async () => {
    const rpc = mockRpc((_n, args) =>
      args.p_tenant_id === "tenant-B"
        ? { data: null, error: { code: "42501", message: "cross-tenant run_id" } }
        : { data: [{ request_id: 1, inserted: true }], error: null },
    );

    const written = await writeImprovementRows(
      [cluster({ tenant_id: "tenant-B" }), cluster({ tenant_id: "tenant-A" })],
      "nightly-2026-06-07",
    );

    expect(written).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("a cluster with ZERO run_ids is skipped (no empty loss-set enqueued)", async () => {
    const rpc = mockRpc(() => ({ data: [{ request_id: 1, inserted: true }], error: null }));
    const written = await writeImprovementRows([cluster({ run_ids: [] })], "nightly-2026-06-07");
    expect(written).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("no clusters ⇒ zero rows, no serviceClient touched", async () => {
    const written = await writeImprovementRows([], "nightly-2026-06-07");
    expect(written).toBe(0);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});

describe("disabled (flag=0) still holds for the row-writer (no RPC)", () => {
  it("flag = '0' ⇒ runNightlySelfImprove returns enabled:false and issues ZERO writes", async () => {
    process.env[NIGHTLY_SELF_IMPROVE_FLAG] = "0";
    const r = await runNightlySelfImprove();
    expect(r).toEqual({ enabled: false });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it("flag ON but fleet halted ⇒ no improvement rows written (short-circuit before scan)", async () => {
    process.env[NIGHTLY_SELF_IMPROVE_FLAG] = "1";
    mocks.isFleetHalted.mockResolvedValue(true);
    const r = await runNightlySelfImprove();
    expect(r.halted).toBe(true);
    expect(r.improvement_rows_written).toBeUndefined();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});
