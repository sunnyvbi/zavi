
import { describe, it, expect, vi, afterEach } from "vitest";

const flag = vi.hoisted(() => ({ hybrid: false }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => flag.hybrid),
}));

import { build } from "../pm";
import type { DashboardContext } from "../_contract";

const NOW = new Date("2026-06-19T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  flag.hybrid = false;
});

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  function table(name: string) {
    const eqs: Array<[string, unknown]> = [];
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    const gtes: Array<[string, string]> = [];
    const lts: Array<[string, string]> = [];
    let countMode = false;
    let limitN: number | undefined;
    const chain: Record<string, unknown> = {
      select(_cols?: unknown, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === "exact") countMode = true;
        return chain;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push({ col, vals });
        return chain;
      },
      gte(col: string, val: string) {
        gtes.push([col, val]);
        return chain;
      },
      lt(col: string, val: string) {
        lts.push([col, val]);
        return chain;
      },
      order: () => chain,
      limit(n?: number) {
        if (typeof n === "number") limitN = n;
        return chain;
      },
      filtered(): Row[] {
        let rows = tables[name] ?? [];
        for (const [col, val] of eqs) rows = rows.filter((r) => r[col] === val);
        for (const f of inFilters) {
          rows = rows.filter((r) => f.vals.includes(r[f.col]));
        }
        for (const [col, bound] of gtes) {
          rows = rows.filter((r) => {
            const v = r[col];
            return typeof v === "string" && Date.parse(v) >= Date.parse(bound);
          });
        }
        for (const [col, bound] of lts) {
          rows = rows.filter((r) => {
            const v = r[col];
            return typeof v === "string" && Date.parse(v) < Date.parse(bound);
          });
        }
        if (!countMode && typeof limitN === "number") rows = rows.slice(0, limitN);
        return rows;
      },
      then(resolve: (v: Record<string, unknown>) => unknown) {
        const rows = (chain.filtered as () => Row[])();
        const result = countMode
          ? { data: null, count: rows.length, error: null }
          : { data: rows, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  }
  return { from: (name: string) => table(name) };
}

function ctx(tenantId: string, tables: Record<string, Row[]>): DashboardContext {
  return {
    tenantId,
    sb: makeSb(tables) as unknown,
  } as unknown as DashboardContext;
}

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("pm dashboard builder — flow vitals", () => {
  it("buckets inflow/dispatch into trailing UTC weeks + tallies the lifecycle distribution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const rows: Row[] = [
      {
        id: "r1",
        tenant_id: A,
        theme: "Slack reply swallow",
        status: "in_flight",
        outcome: null,
        child_run_id: "c1",
        first_seen_at: "2026-06-16T09:00:00Z",
        last_dispatched_at: "2026-06-16T10:00:00Z",
        updated_at: "2026-06-16T10:00:00Z",
      },
      {
        id: "r2",
        tenant_id: A,
        theme: "Grounding banner false fire",
        status: "measured",
        outcome: "won",
        child_run_id: null,
        first_seen_at: "2026-06-02T00:00:00Z",
        last_dispatched_at: "2026-06-09T00:00:00Z",
        updated_at: "2026-06-11T00:00:00Z",
      },
      {
        id: "r3",
        tenant_id: A,
        theme: "Engineer courtesy turn boots sandbox",
        status: "proposed",
        outcome: "recurred",
        child_run_id: null,
        first_seen_at: "2026-05-26T00:00:00Z",
        last_dispatched_at: null,
        updated_at: "2026-06-18T00:00:00Z",
      },
      {
        id: "r4",
        tenant_id: A,
        theme: "ancient proposed",
        status: "proposed",
        outcome: null,
        child_run_id: null,
        first_seen_at: "2026-03-01T00:00:00Z",
        last_dispatched_at: "2026-03-02T00:00:00Z",
        updated_at: "2026-03-02T00:00:00Z",
      },
    ];

    const d = (await build(ctx(A, { pm_roadmap: rows, agent_runs: [] }))) as any;
    const fv = d.flow_vitals;

    expect(fv.inflow_vs_dispatch).toHaveLength(5);
    expect(fv.inflow_vs_dispatch.map((w: any) => w.week_start.slice(0, 10))).toEqual([
      "2026-05-18",
      "2026-05-25",
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);

    const byWeek: Record<string, { inflow: number; dispatched: number }> = {};
    for (const w of fv.inflow_vs_dispatch) {
      byWeek[w.week_start.slice(0, 10)] = { inflow: w.inflow, dispatched: w.dispatched };
    }
    expect(byWeek["2026-05-25"]).toEqual({ inflow: 1, dispatched: 0 });
    expect(byWeek["2026-06-01"]).toEqual({ inflow: 1, dispatched: 0 });
    expect(byWeek["2026-06-08"]).toEqual({ inflow: 0, dispatched: 1 });
    expect(byWeek["2026-06-15"]).toEqual({ inflow: 1, dispatched: 1 });
    const totalInflow = fv.inflow_vs_dispatch.reduce((s: number, w: any) => s + w.inflow, 0);
    const totalDispatched = fv.inflow_vs_dispatch.reduce(
      (s: number, w: any) => s + w.dispatched,
      0,
    );
    expect(totalInflow).toBe(3);
    expect(totalDispatched).toBe(2);

    expect(fv.outcomes).toEqual({
      proposed: 2,
      in_flight: 1,
      shipped_measured: 1,
      won: 1,
      recurred: 1,
    });
  });

  it("CROSS-TENANT: tenant A's flow vitals never include tenant B's rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const aRow: Row = {
      id: "a1",
      tenant_id: A,
      theme: "A theme",
      status: "in_flight",
      outcome: null,
      child_run_id: null,
      first_seen_at: "2026-06-16T00:00:00Z",
      last_dispatched_at: "2026-06-16T00:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    };
    const bRows: Row[] = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      tenant_id: B,
      theme: `B leak ${i}`,
      status: "measured",
      outcome: "recurred",
      child_run_id: null,
      first_seen_at: "2026-06-16T00:00:00Z",
      last_dispatched_at: "2026-06-16T00:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    }));

    const d = (await build(
      ctx(A, { pm_roadmap: [aRow, ...bRows], agent_runs: [] }),
    )) as any;

    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].theme).toBe("A theme");
    const fv = d.flow_vitals;
    const totalInflow = fv.inflow_vs_dispatch.reduce((s: number, w: any) => s + w.inflow, 0);
    expect(totalInflow).toBe(1);
    expect(fv.outcomes).toEqual({
      proposed: 0,
      in_flight: 1,
      shipped_measured: 0,
      won: 0,
      recurred: 0,
    });

    const dB = (await build(
      ctx(B, { pm_roadmap: [aRow, ...bRows], agent_runs: [] }),
    )) as any;
    expect(dB.rows).toHaveLength(6);
    expect(dB.flow_vitals.outcomes.recurred).toBe(6);
    expect(dB.flow_vitals.outcomes.in_flight).toBe(0);
  });

  it("does NOT undercount flow vitals when a tenant has >100 roadmap rows (P1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const rows: Row[] = Array.from({ length: 130 }, (_, i) => ({
      id: `r${i}`,
      tenant_id: A,
      theme: `theme ${i}`,
      status: "in_flight",
      outcome: null,
      child_run_id: null,
      first_seen_at: "2026-06-16T00:00:00Z",
      last_dispatched_at: "2026-06-16T00:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    }));

    const d = (await build(ctx(A, { pm_roadmap: rows, agent_runs: [] }))) as any;
    const totalInflow = d.flow_vitals.inflow_vs_dispatch.reduce(
      (s: number, w: any) => s + w.inflow,
      0,
    );
    expect(totalInflow).toBe(130);
    expect(d.flow_vitals.outcomes.in_flight).toBe(130);

    expect(d.rows).toHaveLength(100);
    expect(d.kpis.in_flight).toBe(130);
    expect(d.kpis).toEqual({
      in_flight: d.flow_vitals.outcomes.in_flight,
      shipped_measured: d.flow_vitals.outcomes.shipped_measured,
      won: d.flow_vitals.outcomes.won,
      recurred: d.flow_vitals.outcomes.recurred,
    });
  });

  it("FIRST-TIME / empty: renders a zeroed 5-week skeleton + zero outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const d = (await build(ctx(A, { pm_roadmap: [], agent_runs: [] }))) as any;
    expect(d.rows).toEqual([]);
    expect(d.flow_vitals.inflow_vs_dispatch).toHaveLength(5);
    for (const w of d.flow_vitals.inflow_vs_dispatch) {
      expect(w.inflow).toBe(0);
      expect(w.dispatched).toBe(0);
    }
    expect(d.flow_vitals.outcomes).toEqual({
      proposed: 0,
      in_flight: 0,
      shipped_measured: 0,
      won: 0,
      recurred: 0,
    });
  });
});

describe("pm dashboard builder — pm_hybrid_surface flag", () => {
  const roadmapRows: Row[] = [
    {
      id: "r1",
      tenant_id: A,
      theme: "Slack reply swallow",
      status: "in_flight",
      outcome: null,
      child_run_id: "c1",
      first_seen_at: "2026-06-05T00:00:00Z",
      last_dispatched_at: "2026-06-09T12:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    },
    {
      id: "r2",
      tenant_id: A,
      theme: "Grounding banner false fire",
      status: "measured",
      outcome: "won",
      child_run_id: null,
      first_seen_at: "2026-06-01T00:00:00Z",
      last_dispatched_at: "2026-06-08T00:00:00Z",
      updated_at: "2026-06-11T00:00:00Z",
    },
  ];

  const agentRuns: Row[] = [
    {
      id: "c1",
      tenant_id: A,
      agent_slug: "engineer",
      status: "success",
      finished_at: "2026-06-10T00:00:00Z",
      parsed: { pr_url: "https://github.com/acme/app/pull/1" },
    },
    {
      id: "pm1",
      tenant_id: A,
      agent_slug: "pm",
      status: "success",
      finished_at: "2026-06-18T00:00:00Z",
      parsed: {
        status: "actionable",
        summary: { bullets: ["Shipped grounding fix", "Two themes in flight"] },
        backlog: [
          { item_id: "b1", theme: "Slack reply swallow" },
          { item_id: "b2", theme: "Onboarding empty state" },
        ],
        dispatched_actions: [{ item_id: "b1", target_agent_slug: "engineer" }],
        recommended_actions_not_dispatched: [
          { item_id: "b2", description: "Fix onboarding empty state", needs_go: true, urgency: "now" },
          { item_id: "b3", description: "Add export button", needs_go: false, urgency: "this-week" },
        ],
      },
    },
  ];

  it("flag OFF → payload shape unchanged (no dispatch_stage / standup keys)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    flag.hybrid = false;

    const d = (await build(
      ctx(A, { pm_roadmap: roadmapRows, agent_runs: agentRuns }),
    )) as any;

    expect(d).not.toHaveProperty("standup");
    expect(d.rows).toHaveLength(2);
    for (const r of d.rows) {
      expect(r).not.toHaveProperty("dispatch_stage");
      expect(r).not.toHaveProperty("pr_url");
      expect(r).not.toHaveProperty("pr_state");
      expect(r).not.toHaveProperty("days_stuck");
    }
    expect(Object.keys(d).sort()).toEqual(
      ["attention", "flow_vitals", "kpis", "rows"].sort(),
    );
  });

  it("flag ON → rows carry lifecycle fields + standup is populated from the envelope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    flag.hybrid = true;

    const d = (await build(
      ctx(A, { pm_roadmap: roadmapRows, agent_runs: agentRuns }),
    )) as any;

    const r1 = d.rows.find((r: any) => r.id === "r1");
    const r2 = d.rows.find((r: any) => r.id === "r2");
    expect(r1.dispatch_stage).toBe("pr_open");
    expect(r1.pr_url).toBe("https://github.com/acme/app/pull/1");
    expect(r1.pr_state).toBeNull();
    expect(r1.days_stuck).toBe(10);

    expect(r2.dispatch_stage).toBe("dispatched");
    expect(r2.pr_url).toBeNull();
    expect(r2.pr_state).toBeNull();
    expect(r2.days_stuck).toBeNull();

    expect(d.standup).not.toBeNull();
    expect(d.standup.judgment).toEqual({
      candidates_found: 3,
      dispatched_count: 1,
      skipped: [
        {
          theme: "Onboarding empty state",
          why: "Held for your approval — auto-dispatch precision below threshold.",
        },
        {
          theme: "Add export button",
          why: "Not dispatched this run — reason not recorded · urgency: this-week",
        },
      ],
    });
    for (const s of d.standup.judgment.skipped) {
      if (d.standup.judgment.dispatched_count < 3) {
        expect(s.why).not.toContain("top-3");
      }
    }
    expect(d.standup.summary_bullets).toEqual([
      "Shipped grounding fix",
      "Two themes in flight",
    ]);
    expect(d.standup.loop_closed).toEqual([
      { theme: "Grounding banner false fire", outcome: "won" },
    ]);
    expect(d.standup.needs_you_count).toBe(1);
    expect(d.standup.moving_clean_count).toBe(0);
  });

  it("flag ON but no successful pm run → standup degrades to null (never throws)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    flag.hybrid = true;

    const d = (await build(
      ctx(A, {
        pm_roadmap: roadmapRows,
        agent_runs: agentRuns.filter((r) => r.agent_slug === "engineer"),
      }),
    )) as any;

    expect(d.standup).toBeNull();
    const r1 = d.rows.find((r: any) => r.id === "r1");
    expect(r1.dispatch_stage).toBe("pr_open");
  });

  it("failed engineer child badges failed_to_open (not engineer_done); counts + reason are sourced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    flag.hybrid = true;

    const TEN_DAYS_AGO = "2026-06-09T12:00:00Z";
    const TWO_DAYS_AGO = "2026-06-17T12:00:00Z";

    const rows: Row[] = [
      { id: "rmA", tenant_id: A, theme: "Failed dispatch", status: "in_flight", outcome: null, child_run_id: "chFail", first_seen_at: TEN_DAYS_AGO, last_dispatched_at: TEN_DAYS_AGO, updated_at: TEN_DAYS_AGO },
      { id: "rmB", tenant_id: A, theme: "Clean in flight", status: "in_flight", outcome: null, child_run_id: "chClean", first_seen_at: TWO_DAYS_AGO, last_dispatched_at: TWO_DAYS_AGO, updated_at: TWO_DAYS_AGO },
      { id: "rmC", tenant_id: A, theme: "Came back", status: "proposed", outcome: "recurred", child_run_id: null, first_seen_at: TEN_DAYS_AGO, last_dispatched_at: TEN_DAYS_AGO, updated_at: TEN_DAYS_AGO },
      { id: "rmD", tenant_id: A, theme: "Stuck in review", status: "in_flight", outcome: null, child_run_id: "chStuck", first_seen_at: TEN_DAYS_AGO, last_dispatched_at: TEN_DAYS_AGO, updated_at: TEN_DAYS_AGO },
    ];

    const runs: Row[] = [
      { id: "chFail", tenant_id: A, agent_slug: "engineer", status: "failed", finished_at: TEN_DAYS_AGO, parsed: {} },
      { id: "chClean", tenant_id: A, agent_slug: "engineer", status: "success", finished_at: TWO_DAYS_AGO, parsed: { pr_url: "https://github.com/acme/app/pull/9" } },
      { id: "chStuck", tenant_id: A, agent_slug: "engineer", status: "success", finished_at: TEN_DAYS_AGO, parsed: { pr_url: "https://github.com/acme/app/pull/8" } },
      { id: "pmX", tenant_id: A, agent_slug: "pm", status: "success", finished_at: "2026-06-18T00:00:00Z", parsed: {
        status: "actionable",
        summary: { bullets: [] },
        backlog: [{ item_id: "z1", theme: "No-reason item" }],
        dispatched_actions: [],
        recommended_actions_not_dispatched: [{ item_id: "z1", description: "Something" }],
      } },
    ];

    const d = (await build(ctx(A, { pm_roadmap: rows, agent_runs: runs }))) as any;

    const rmA = d.rows.find((r: any) => r.id === "rmA");
    expect(rmA.dispatch_stage).toBe("failed_to_open");
    expect(rmA.dispatch_stage).not.toBe("engineer_done");

    expect(d.standup.needs_you_count).toBe(3);
    expect(d.standup.moving_clean_count).toBe(1);

    expect(d.standup.judgment.skipped).toEqual([
      { theme: "No-reason item", why: "Reason not recorded" },
    ]);
  });

  it("skip reason says 'top-3' ONLY when the dispatch cap actually bound (dispatched>=3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    flag.hybrid = true;

    const runs: Row[] = [
      { id: "pmY", tenant_id: A, agent_slug: "pm", status: "success", finished_at: "2026-06-18T00:00:00Z", parsed: {
        status: "actionable",
        summary: { bullets: [] },
        backlog: [{ item_id: "k4", theme: "Below the cut" }],
        dispatched_actions: [
          { item_id: "k1", target_agent_slug: "engineer" },
          { item_id: "k2", target_agent_slug: "engineer" },
          { item_id: "k3", target_agent_slug: "engineer" },
        ],
        recommended_actions_not_dispatched: [{ item_id: "k4", description: "Below the cut", needs_go: false, urgency: "now" }],
      } },
    ];

    const d = (await build(ctx(A, { pm_roadmap: [], agent_runs: runs }))) as any;
    expect(d.standup.judgment.dispatched_count).toBe(3);
    expect(d.standup.judgment.skipped).toEqual([
      { theme: "Below the cut", why: "Not in this run's top-3 dispatch batch · urgency: now" },
    ]);
  });
});
