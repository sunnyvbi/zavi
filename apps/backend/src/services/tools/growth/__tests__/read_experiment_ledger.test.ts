
import { describe, it, expect, vi, beforeEach } from "vitest";

type BuilderResult = { data: unknown[] | null; error: { message: string } | null };
const calls: Record<string, unknown[][]> = {};
let outcomesResult: BuilderResult = { data: [], error: null };
let decisionsResult: BuilderResult = { data: [], error: null };
let currentTable = "";

function makeBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "or", "gte", "in", "order", "limit"]) {
    b[m] = vi.fn((...args: unknown[]) => {
      (calls[`${currentTable}.${m}`] ??= []).push(args);
      return b;
    });
  }
  const table = currentTable;
  b.then = (resolve: (v: BuilderResult) => unknown) =>
    resolve(table === "decisions" ? decisionsResult : outcomesResult);
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn((table: string) => {
      (calls.from ??= []).push([table]);
      currentTable = table;
      return makeBuilder();
    }),
  }),
}));

import { readExperimentLedgerTool } from "../read_experiment_ledger";
import { ExpectedToolError } from "@/services/tools/types";

const ctx = { tenant_id: "tenant-A", log: () => {} };

const PAST = "2026-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

const launchedMeasuredRow = {
  id: 11,
  decision_id: "dec-1",
  action_class: "meta_ads.update_ad_set_budget",
  decision_outcome: "approved",
  subject_type: "adset",
  subject_id: "238001",
  subject_name: "Gig Rentals Purchase",
  target_metric: "spend",
  baseline_metrics: { spend: 84, roas: 2.1, conversions: 12, secret_extra: "drop-me" },
  outcome_metrics: { spend: 110, roas: 2.7 },
  delta_metrics: { spend: 26, roas: 0.6 },
  reconcile_status: "measured",
  reconcile_after: PAST,
  measurement_window_days: 14,
  measured_at: "2026-01-15T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
};

const launchedPendingRow = {
  ...launchedMeasuredRow,
  id: 12,
  decision_id: "dec-2",
  subject_name: "Spring UGC v3",
  reconcile_status: "pending",
  reconcile_after: FUTURE,
  measured_at: null,
  outcome_metrics: {},
  delta_metrics: {},
};

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  outcomesResult = { data: [], error: null };
  decisionsResult = { data: [], error: null };
});

describe("growth_read_experiment_ledger", () => {
  it("scopes BOTH reads to ctx.tenant_id (C8) and hard-filters action_class to meta_ads.%", async () => {
    outcomesResult = { data: [launchedMeasuredRow], error: null };
    decisionsResult = { data: [{ id: "dec-1", body: { rationale: "test it" } }], error: null };
    await readExperimentLedgerTool.execute(ctx, {});
    expect(calls.from).toEqual([["action_outcomes"], ["decisions"]]);
    expect(calls["action_outcomes.eq"]).toEqual([["tenant_id", "tenant-A"]]);
    expect(calls["action_outcomes.or"]).toEqual([["action_class.like.meta_ads.%"]]);
    expect(calls["decisions.eq"]).toEqual([["tenant_id", "tenant-A"]]);
  });

  it("a paid specialist reads only its own channel's launches, never Meta's", async () => {
    const out = (await readExperimentLedgerTool.execute({ ...ctx, agent_slug: "chatgpt_ads" }, {
      agent_slug: "operator",
      action_class: "meta_ads.%",
    })) as {
      action_class_scope: string;
      has_data: boolean;
      note: string;
    };
    expect(calls["action_outcomes.or"]).toEqual([["action_class.like.chatgpt_ads.%"]]);
    expect(out.action_class_scope).toBe("chatgpt_ads.*");
    expect(out.has_data).toBe(false);
    expect(out.note).toContain("chatgpt_ads.*");
    expect(out.note).not.toContain("meta_ads");
    expect(out.note).toContain("does not establish whether unmeasured changes exist");
    await readExperimentLedgerTool.execute({ ...ctx, agent_slug: "meta_ads" }, {});
    expect(calls["action_outcomes.or"][1]).toEqual(["action_class.like.meta_ads.%"]);
  });

  it("class scope cannot be widened from input (unknown keys stripped by zod)", async () => {
    await readExperimentLedgerTool.execute(ctx, { action_class: "ceo.%", limit: 5 } as never);
    expect(calls["action_outcomes.or"]).toEqual([["action_class.like.meta_ads.%"]]);
    expect(calls["action_outcomes.limit"]).toEqual([[5]]);
  });

  it("LAUNCHED-only: zero outcome rows → has_data:false + never-fabricate note (a floated idea is NOT a launch)", async () => {
    outcomesResult = { data: [], error: null };
    const out = (await readExperimentLedgerTool.execute(ctx, {})) as {
      has_data: boolean;
      rows: unknown[];
      readout_due_count: number;
      note: string;
    };
    expect(out.has_data).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.readout_due_count).toBe(0);
    expect(out.note).toMatch(/never fabricate/i);
    expect(calls.from).toEqual([["action_outcomes"]]);
  });

  it("a LAUNCHED change past readout_due surfaces readout_due:true + measured result + hypothesis from decisions.body.rationale", async () => {
    outcomesResult = { data: [launchedMeasuredRow], error: null };
    decisionsResult = {
      data: [{ id: "dec-1", body: { rationale: "under-delivering its cap; +30% lifts volume", name: "x" } }],
      error: null,
    };
    const out = (await readExperimentLedgerTool.execute(ctx, {})) as {
      has_data: boolean;
      readout_due_count: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(out.has_data).toBe(true);
    expect(out.readout_due_count).toBe(1);
    const r = out.rows[0];
    expect(r.readout_due).toBe(true);
    expect(r.hypothesis).toBe("under-delivering its cap; +30% lifts volume");
    expect(r.result).toEqual({ spend: 26, roas: 0.6 });
    expect(r.baseline).toEqual({ spend: 84, roas: 2.1, conversions: 12 });
  });

  it("a pending launch (future readout) → readout_due:false, result:null (still measuring), and a missing rationale → hypothesis:null (never invented)", async () => {
    outcomesResult = { data: [launchedPendingRow], error: null };
    decisionsResult = { data: [{ id: "dec-2", body: { name: "Spring UGC v3" } }], error: null };
    const out = (await readExperimentLedgerTool.execute(ctx, {})) as {
      readout_due_count: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(out.readout_due_count).toBe(0);
    const r = out.rows[0];
    expect(r.readout_due).toBe(false);
    expect(r.result).toBeNull();
    expect(r.hypothesis).toBeNull();
  });

  it("DB error on the outcomes read → ExpectedToolError (digest survives)", async () => {
    outcomesResult = { data: null, error: { message: "boom" } };
    await expect(readExperimentLedgerTool.execute(ctx, {})).rejects.toBeInstanceOf(
      ExpectedToolError,
    );
  });

  it("a decisions-read failure degrades to hypothesis:null, never throws (best-effort join)", async () => {
    outcomesResult = { data: [launchedMeasuredRow], error: null };
    decisionsResult = { data: null, error: { message: "transient" } };
    const out = (await readExperimentLedgerTool.execute(ctx, {})) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(out.rows[0].hypothesis).toBeNull();
  });

  it("input bounds: defaults days=90 limit=20; zod rejects out-of-range", async () => {
    await readExperimentLedgerTool.execute(ctx, {});
    expect(calls["action_outcomes.limit"]).toEqual([[20]]);
    await expect(readExperimentLedgerTool.execute(ctx, { days: 0 })).rejects.toThrow();
    await expect(readExperimentLedgerTool.execute(ctx, { limit: 999 })).rejects.toThrow();
  });
});
