
import { describe, it, expect, vi, beforeEach } from "vitest";

type BuilderResult = { data: unknown[] | null; error: { message: string } | null };
const calls: Record<string, unknown[][]> = {};
let result: BuilderResult = { data: [], error: null };

function makeBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "like", "or", "gte", "order", "limit"]) {
    b[m] = vi.fn((...args: unknown[]) => {
      (calls[m] ??= []).push(args);
      return b;
    });
  }
  b.then = (resolve: (v: BuilderResult) => unknown) => resolve(result);
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn((table: string) => {
      (calls.from ??= []).push([table]);
      return makeBuilder();
    }),
  }),
}));

import { readActionOutcomesTool } from "../read_action_outcomes";
import { ExpectedToolError } from "@/services/tools/types";

const ctx = { tenant_id: "tenant-A", log: () => {} };

const measuredRow = {
  id: 7,
  action_class: "meta_ads.update_ad_set_budget",
  decision_outcome: "approved",
  subject_type: "adset",
  subject_id: "238001",
  subject_name: "Gig Rentals Purchase",
  target_metric: "spend",
  baseline_metrics: { spend: 84, roas: 2.1, conversions: 12, secret_extra: "drop-me" },
  outcome_metrics: { spend: 110, roas: 2.7, conversions: 19 },
  delta_metrics: { spend: 26, roas: 0.6, conversions: 7 },
  reconcile_status: "measured",
  measurement_window_days: 14,
  measurement_window_start: "2026-05-20T00:00:00Z",
  measurement_window_end: "2026-06-03T00:00:00Z",
  reconcile_after: "2026-06-03T00:00:00Z",
  measured_at: "2026-06-03T01:00:00Z",
  created_at: "2026-05-20T00:00:00Z",
};

const pendingRow = {
  ...measuredRow,
  id: 8,
  action_class: "meta_ads.set_status",
  subject_name: "Spring UGC v3",
  reconcile_status: "pending",
  reconcile_after: "2026-06-18T00:00:00Z",
  measured_at: null,
  outcome_metrics: {},
  delta_metrics: {},
};

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  result = { data: [], error: null };
});

describe("growth_read_action_outcomes", () => {
  it("scopes the query to ctx.tenant_id (C8 — never LLM input)", async () => {
    await readActionOutcomesTool.execute(ctx, {});
    expect(calls.from).toEqual([["action_outcomes"]]);
    expect(calls.eq).toEqual([["tenant_id", "tenant-A"]]);
  });

  const PAID_ADS_OR = "action_class.like.meta_ads.%,action_class.like.google_ads.%,action_class.like.linkedin_ads.%";

  it("hard-filters action_class to the paid-ads classes server-side", async () => {
    const out = await readActionOutcomesTool.execute(ctx, {}) as { action_class_scope: string };
    expect(calls.or).toEqual([[PAID_ADS_OR]]);
    expect(out.action_class_scope).toBe("meta_ads.*, google_ads.*, linkedin_ads.*");
    expect(calls.like).toBeUndefined();
  });

  it("includes google_ads rows in the scoreboard, not just meta", async () => {
    await readActionOutcomesTool.execute(ctx, {});
    expect(calls.or[0][0]).toContain("google_ads.%");
    expect(calls.or[0][0]).toContain("meta_ads.%");
    expect(calls.or[0][0]).toContain("linkedin_ads.%");
  });

  it("the LinkedIn specialist's scoreboard is its own channel only, so Meta rows never grade a LinkedIn run", async () => {
    const out = await readActionOutcomesTool.execute({ ...ctx, agent_slug: "linkedin_ads" }, {}) as { action_class_scope: string };
    expect(out.action_class_scope).toBe("linkedin_ads.*");
    expect(calls.or.at(-1)).toEqual(["action_class.like.linkedin_ads.%"]);
  });

  it("a paid specialist reads only its own channel's outcomes", async () => {
    const out = await readActionOutcomesTool.execute({ ...ctx, agent_slug: "chatgpt_ads" }, {
      agent_slug: "operator",
      action_class: "meta_ads.%",
    }) as { action_class_scope: string; has_data: boolean; note: string };
    expect(out.action_class_scope).toBe("chatgpt_ads.*");
    expect(out.has_data).toBe(false);
    expect(out.note).toContain("chatgpt_ads.*");
    expect(out.note).not.toContain("meta_ads");
    expect(out.note).toContain("does not establish whether unmeasured changes exist");
    await readActionOutcomesTool.execute({ ...ctx, agent_slug: "meta_ads" }, {});
    await readActionOutcomesTool.execute({ ...ctx, agent_slug: "youtube_ads" }, {});
    expect(calls.or).toEqual([
      ["action_class.like.chatgpt_ads.%"],
      ["action_class.like.meta_ads.%"],
      ["action_class.like.youtube_ads.%,action_class.like.google_ads.%"],
    ]);
  });

  it("class scope cannot be widened from input (unknown keys are ignored by zod)", async () => {
    await readActionOutcomesTool.execute(ctx, {
      action_class: "ceo.%",
      days: 30,
      limit: 5,
    });
    expect(calls.or).toEqual([[PAID_ADS_OR]]);
    expect(calls.limit).toEqual([[5]]);
  });

  it("EMPTY state → has_data:false + zero counts + honest never-fabricate note", async () => {
    result = { data: [], error: null };
    const out = (await readActionOutcomesTool.execute(ctx, {})) as {
      has_data: boolean;
      counts: Record<string, number>;
      rows: unknown[];
      note: string;
    };
    expect(out.has_data).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.counts).toEqual({ measured: 0, pending: 0, no_data: 0, error: 0 });
    expect(out.note).toMatch(/never fabricate/i);
  });

  it("maps measured + pending rows: whitelisted metrics, status counts, pending due-date", async () => {
    result = { data: [measuredRow, pendingRow], error: null };
    const out = (await readActionOutcomesTool.execute(ctx, {})) as {
      has_data: boolean;
      counts: Record<string, number>;
      rows: Array<Record<string, unknown>>;
    };
    expect(out.has_data).toBe(true);
    expect(out.counts).toEqual({ measured: 1, pending: 1, no_data: 0, error: 0 });

    const m = out.rows[0];
    expect(m.subject_name).toBe("Gig Rentals Purchase");
    expect(m.delta).toEqual({ spend: 26, roas: 0.6, conversions: 7 });
    expect(m.baseline).toEqual({ spend: 84, roas: 2.1, conversions: 12 });
    expect(m.measurement_due).toBeNull();

    const p = out.rows[1];
    expect(p.reconcile_status).toBe("pending");
    expect(p.measurement_due).toBe("2026-06-18T00:00:00Z");
    expect(p.delta).toBeNull();
  });

  it("DB error → ExpectedToolError (digest survives, scoreboard reported unavailable)", async () => {
    result = { data: null, error: { message: "boom" } };
    await expect(readActionOutcomesTool.execute(ctx, {})).rejects.toBeInstanceOf(
      ExpectedToolError,
    );
  });

  it("input bounds: defaults days=90 limit=20; zod rejects out-of-range", async () => {
    await readActionOutcomesTool.execute(ctx, {});
    expect(calls.limit).toEqual([[20]]);
    await expect(readActionOutcomesTool.execute(ctx, { days: 0 })).rejects.toThrow();
    await expect(readActionOutcomesTool.execute(ctx, { limit: 999 })).rejects.toThrow();
  });
});
