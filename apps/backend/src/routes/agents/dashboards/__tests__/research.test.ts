
import { describe, it, expect } from "vitest";
import { build } from "../research";
import type { DashboardContext } from "../_contract";

function makeFilteringSb(tables: Record<string, Record<string, unknown>[]>) {
  let current: string | null = null;
  let preds: Array<(row: Record<string, unknown>) => boolean> = [];
  const chain: Record<string, unknown> = {
    from(t: string) {
      current = t;
      preds = [];
      return chain;
    },
    select: () => chain,
    eq(col: string, val: unknown) {
      preds.push((row) => row[col] === val);
      return chain;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      preds.push((row) => set.has(row[col]));
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      const rows = (tables[current ?? ""] ?? []).filter((row) =>
        preds.every((p) => p(row)),
      );
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return chain;
}

function makeThrowingSb() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: null; error: { message: string } }) => unknown) {
      return Promise.resolve({
        data: null,
        error: { message: "boom" },
      }).then(resolve);
    },
  };
  return chain;
}

function ctx(
  tenantId: string,
  tables: Record<string, Record<string, unknown>[]>,
): DashboardContext {
  return {
    tenantId,
    sb: makeFilteringSb(tables),
  } as unknown as DashboardContext;
}

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

function researchRun(
  over: Partial<Record<string, unknown>> & { tenant_id: string },
) {
  return {
    agent_slug: "research",
    status: "success",
    enqueued_at: "2026-06-18T00:00:00Z",
    parsed: {
      kind: "report",
      title: "Untitled",
      query: "Untitled question",
      template: "competitor-teardown",
      blocks: [{ type: "exec_summary", bottom_line: "x", prose_md: "y" }],
      lenses: [],
      sources: [{ n: 1, url: "https://a" }],
      validation: [],
      failed_lenses: [],
    },
    ...over,
  };
}

describe("research dashboard builder — inbox requests", () => {
  it("classifies a success+report run as an `answered` row with the full report embedded + correct mix", async () => {
    const run = researchRun({
      id: "run-1",
      tenant_id: TENANT_A,
      parsed: {
        kind: "report",
        title: "Turo — pricing teardown",
        query: "Tear down Turo pricing",
        subtitle: "5 players · 6 angles · 14 sources",
        template: "competitor-teardown",
        blocks: [
          { type: "exec_summary", bottom_line: "Turo is pricey", prose_md: "x[1]" },
          {
            type: "competitive_table",
            rows: [{ brand: "Turo", positioning: "premium", gap: "fees" }],
          },
        ],
        lenses: [
          {
            lens: "pricing",
            label: "Pricing",
            takeaways: ["fee is 15-40%"],
            provenance: { fetched_urls: ["turo.com"], fetch_errors: 0, poisoned: false },
          },
        ],
        sources: [{ n: 1, url: "https://turo.com" }, { n: 2, url: "https://x.com" }],
        validation: [
          { tier: "validated", text: "fee is 15-40%" },
          { tier: "validated", text: "plans confirmed" },
          { tier: "inferred", text: "positioning" },
          { tier: "assumption", text: "operator fit" },
          { tier: "high-risk", text: "stale figure" },
          { tier: "bogus-tier", text: "ignored — unknown tier" },
        ],
        failed_lenses: [],
        generated_at: "2026-06-18T00:00:00Z",
      },
    });

    const d = (await build(
      ctx(TENANT_A, { agent_runs: [run], run_artifacts: [] }),
    )) as Record<string, any>;

    expect(d.requests).toHaveLength(1);
    const row = d.requests[0];
    expect(row.status).toBe("answered");
    expect(row.query).toBe("Tear down Turo pricing");
    expect(row.sources_count).toBe(2);
    expect(row.validation_mix).toEqual({
      validated: 2,
      inferred: 1,
      assumption: 1,
      high_risk: 1,
      total: 5,
    });
    expect(row.report).toBeTruthy();
    expect(row.report.title).toBe("Turo — pricing teardown");
    expect(row.report.subtitle).toBe("5 players · 6 angles · 14 sources");
    expect(row.report.blocks).toHaveLength(2);
    expect(row.report.blocks[1].type).toBe("competitive_table");
    expect(row.report.lenses).toHaveLength(1);
    expect(row.report.validation).toHaveLength(6);
    expect(row.questions).toBeNull();
    expect(d.kpis.reports_produced).toBe(1);
    expect(d.kpis.sources_cited).toBe(2);
  });

  it("classifies a clarification run as `needs_you` carrying questions (any run status)", async () => {
    const run = researchRun({
      id: "run-clarify",
      tenant_id: TENANT_A,
      status: "success",
      parsed: {
        kind: "clarification",
        query: "Should we add a delivery option?",
        template: "freeform",
        questions: [
          { question: "Delivery for which product line?", why: "changes the set" },
          { question: "Deliver the car, or handoff?", why: "different ops" },
        ],
      },
    });
    const d = (await build(
      ctx(TENANT_A, { agent_runs: [run], run_artifacts: [] }),
    )) as Record<string, any>;
    expect(d.requests).toHaveLength(1);
    const row = d.requests[0];
    expect(row.status).toBe("needs_you");
    expect(row.query).toBe("Should we add a delivery option?");
    expect(row.questions).toHaveLength(2);
    expect(row.questions[0]).toEqual({
      question: "Delivery for which product line?",
      why: "changes the set",
    });
    expect(row.report).toBeNull();
    expect(d.kpis.reports_produced).toBe(0);
  });

  it("classifies a running / queued run as a `running` row", async () => {
    const running = researchRun({
      id: "run-running",
      tenant_id: TENANT_A,
      status: "running",
      parsed: { kind: "report", query: "Compare Getaround vs Turo" },
    });
    const queued = researchRun({
      id: "run-queued",
      tenant_id: TENANT_A,
      status: "queued",
      parsed: null,
    });
    const d = (await build(
      ctx(TENANT_A, { agent_runs: [running, queued], run_artifacts: [] }),
    )) as Record<string, any>;
    const statuses = d.requests.map((r: any) => r.status);
    expect(statuses).toEqual(["running", "running"]);
    expect(d.requests[0].query).toBe("Compare Getaround vs Turo");
    expect(d.requests[1].query).toBe("Researching…");
    expect(d.requests[0].report).toBeNull();
    expect(d.kpis.reports_produced).toBe(0);
  });

  it("degrades to { requests: [] } on a read failure (never throws)", async () => {
    const c = {
      tenantId: TENANT_A,
      sb: makeThrowingSb(),
    } as unknown as DashboardContext;
    const d = (await build(c)) as Record<string, any>;
    expect(d).toEqual({ requests: [] });
  });

  it("preserves the thin-sourcing signal (failed lens OR >50% weak tiers) into attention", async () => {
    const failedLens = researchRun({
      id: "run-failed-lens",
      tenant_id: TENANT_A,
      parsed: {
        kind: "report",
        title: "Thin scan",
        query: "thin",
        template: "competitor-teardown",
        blocks: [{ type: "exec_summary", bottom_line: "x", prose_md: "y" }],
        lenses: [],
        sources: [{ n: 1, url: "https://a" }],
        validation: [{ tier: "validated", text: "ok" }],
        failed_lenses: ["releases"],
        generated_at: "2026-06-18T00:00:00Z",
      },
    });
    const d = (await build(
      ctx(TENANT_A, { agent_runs: [failedLens], run_artifacts: [] }),
    )) as Record<string, any>;
    expect(d.requests).toHaveLength(1);
    const thin = d.attention.find((a: any) =>
      a.title.includes("thin sourcing"),
    );
    expect(thin).toBeTruthy();
  });

  it("CROSS-TENANT: tenant A's inbox never includes tenant B's research runs", async () => {
    const aRun = researchRun({
      id: "run-a",
      tenant_id: TENANT_A,
      parsed: {
        kind: "report",
        title: "A's competitor scan",
        query: "A scan",
        template: "competitor-teardown",
        blocks: [{ type: "exec_summary", bottom_line: "x", prose_md: "y" }],
        lenses: [],
        sources: [{ n: 1, url: "https://a" }],
        validation: [{ tier: "validated", text: "ok" }],
        failed_lenses: [],
      },
    });
    const bRun = researchRun({
      id: "run-b",
      tenant_id: TENANT_B,
      parsed: {
        kind: "report",
        title: "B SECRET teardown — must not leak",
        query: "B scan",
        template: "competitor-teardown",
        blocks: [{ type: "exec_summary", bottom_line: "x", prose_md: "y" }],
        lenses: [],
        sources: [{ n: 1, url: "https://b" }],
        validation: [{ tier: "validated", text: "secret" }],
        failed_lenses: [],
      },
    });

    const d = (await build(
      ctx(TENANT_A, {
        agent_runs: [aRun, bRun],
        run_artifacts: [
          { id: "art-b-decoy", run_id: "run-a", filename: "b-secret.pdf", tenant_id: TENANT_B },
          { id: "art-b", run_id: "run-b", filename: "b-other.pdf", tenant_id: TENANT_B },
          { id: "art-a", run_id: "run-a", filename: "a.pdf", tenant_id: TENANT_A },
        ],
      }),
    )) as Record<string, any>;

    const queries = d.requests.map((r: any) => r.query);
    expect(queries).toEqual(["A scan"]);
    expect(queries).not.toContain("B scan");
    expect(d.requests[0].artifact).toEqual({ id: "art-a", filename: "a.pdf" });
    expect(d.kpis.reports_produced).toBe(1);
  });

  it("first-time / empty: no research runs -> empty inbox", async () => {
    const d = (await build(
      ctx(TENANT_A, { agent_runs: [], run_artifacts: [] }),
    )) as Record<string, any>;
    expect(d.requests).toEqual([]);
  });
});
