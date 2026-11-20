
import { describe, it, expect } from "vitest";
import { build } from "../chief-of-staff";
import type { DashboardContext } from "../_contract";

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  let table = "";
  let eqs: Array<[string, unknown]> = [];
  let ins: Array<[string, unknown[]]> = [];
  let neqs: Array<[string, unknown]> = [];
  let likes: Array<[string, string]> = [];
  let countMode = false;

  function applyFilters(rows: Row[]): Row[] {
    let out = rows;
    for (const [k, v] of eqs) {
      out = out.filter((r) => valueAt(r, k) === v);
    }
    for (const [k, vs] of ins) {
      out = out.filter((r) => vs.includes(valueAt(r, k)));
    }
    for (const [k, v] of neqs) {
      out = out.filter((r) => valueAt(r, k) !== v);
    }
    for (const [k, prefix] of likes) {
      const p = prefix.replace(/%$/, "");
      out = out.filter((r) => String(valueAt(r, k) ?? "").startsWith(p));
    }
    return out;
  }

  function valueAt(row: Row, key: string): unknown {
    const m = key.match(/^([^-]+)->>(.+)$/);
    if (m) {
      const obj = row[m[1]];
      if (obj && typeof obj === "object") {
        return (obj as Record<string, unknown>)[m[2]];
      }
      return undefined;
    }
    return row[key];
  }

  const chain: Record<string, unknown> = {
    from(t: string) {
      table = t;
      eqs = [];
      ins = [];
      neqs = [];
      likes = [];
      countMode = false;
      return chain;
    },
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) countMode = true;
      return chain;
    },
    eq: (k: string, v: unknown) => {
      eqs.push([k, v]);
      return chain;
    },
    in: (k: string, vs: unknown[]) => {
      ins.push([k, vs]);
      return chain;
    },
    neq: (k: string, v: unknown) => {
      neqs.push([k, v]);
      return chain;
    },
    like: (k: string, v: string) => {
      likes.push([k, v]);
      return chain;
    },
    gt: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: unknown) => unknown) {
      const filtered = applyFilters(tables[table] ?? []);
      if (countMode) {
        return Promise.resolve({ count: filtered.length, error: null }).then(
          resolve,
        );
      }
      return Promise.resolve({ data: filtered, error: null }).then(resolve);
    },
  };
  return chain;
}

function ctx(tenantId: string, tables: Record<string, Row[]>): DashboardContext {
  return {
    tenantId,
    sb: makeSb(tables),
  } as unknown as DashboardContext;
}

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function dispatchDecision(
  tenant_id: string,
  over: Partial<Row> & { id: string; status: string; emitted_at: string },
): Row {
  return {
    decision_class: "chief-of-staff.dispatch-specialist",
    tenant_id,
    body: { target_agent_slug: "pm", intent: "Re-rank Q3 backlog" },
    dispatched_at: null,
    dispatch_error: null,
    ...over,
  };
}

describe("chief-of-staff dashboard — verdicts + accountability", () => {
  it("excludes daily-digest rows from dispatch queue/in-flight and approval-needed counts", async () => {
    const now = Date.now();
    const decisions: Row[] = [
      dispatchDecision(TENANT_A, {
        id: "cos-dispatch",
        status: "proposed",
        emitted_at: new Date(now - 30_000).toISOString(),
        autonomy_at_emit: "approval",
        body: { target_agent_slug: "engineer", intent: "Fix stale queue render" },
      }),
      {
        id: "cos-digest",
        decision_class: "chief-of-staff.daily-digest",
        tenant_id: TENANT_A,
        status: "proposed",
        autonomy_at_emit: "auto",
        emitted_at: new Date(now - 20_000).toISOString(),
        body: {},
        dispatched_at: null,
        dispatch_error: null,
      },
      {
        id: "other-approval",
        decision_class: "outbound.send",
        tenant_id: TENANT_A,
        status: "proposed",
        autonomy_at_emit: "approval",
        emitted_at: new Date(now - 10_000).toISOString(),
        body: {},
        dispatched_at: null,
        dispatch_error: null,
      },
    ];

    const d = (await build(
      ctx(TENANT_A, { decisions, agent_runs: [] }),
    )) as Record<string, any>;

    expect(d.kpis.pending_cos_dispatches).toBe(1);
    expect(d.kpis.pending_approvals_all).toBe(2);
    expect(d.attention).toHaveLength(1);
    expect(d.attention[0].title).toContain("engineer");
    expect(d.dispatches.map((r: Record<string, unknown>) => r.decision_class)).toEqual([
      "chief-of-staff.dispatch-specialist",
    ]);
    expect(JSON.stringify(d)).not.toContain("chief-of-staff.daily-digest");
  });

  it("maps resolved dispatch decisions to Recent verdicts (newest first, capped)", async () => {
    const now = Date.now();
    const decisions: Row[] = [
      dispatchDecision(TENANT_A, {
        id: "d-approved",
        status: "approved",
        emitted_at: new Date(now - 60_000).toISOString(),
        body: { target_agent_slug: "performance-marketer", intent: "Ship TX reallocation" },
      }),
      dispatchDecision(TENANT_A, {
        id: "d-rejected",
        status: "rejected",
        emitted_at: new Date(now - 120_000).toISOString(),
        body: { target_agent_slug: "support-lead", intent: "Macro rewrite" },
      }),
      dispatchDecision(TENANT_A, {
        id: "d-expired",
        status: "expired",
        emitted_at: new Date(now - 180_000).toISOString(),
      }),
      dispatchDecision(TENANT_A, {
        id: "d-proposed",
        status: "proposed",
        emitted_at: new Date(now - 30_000).toISOString(),
      }),
      {
        id: "d-digest",
        decision_class: "chief-of-staff.daily-digest",
        tenant_id: TENANT_A,
        status: "acted",
        emitted_at: new Date(now - 10_000).toISOString(),
        body: {},
        dispatched_at: null,
        dispatch_error: null,
      },
    ];

    const d = (await build(
      ctx(TENANT_A, { decisions, agent_runs: [] }),
    )) as Record<string, any>;

    const verdicts = d.recent_verdicts as Array<Record<string, unknown>>;
    expect(verdicts.map((v) => v.decision_id)).toEqual([
      "d-approved",
      "d-rejected",
      "d-expired",
    ]);
    expect(verdicts[0]).toMatchObject({ verdict: "approved", target: "performance-marketer" });
    expect(verdicts[1]).toMatchObject({ verdict: "rejected", target: "support-lead" });
    expect(verdicts[2]).toMatchObject({ verdict: "deferred" });
    expect(verdicts.find((v) => v.decision_id === "d-proposed")).toBeUndefined();
    expect(verdicts.find((v) => v.decision_id === "d-digest")).toBeUndefined();
  });

  it("classifies accountability per-agent from the run-join (delivered/on_track/missed/at_risk)", async () => {
    const now = Date.now();
    const recent = (mins: number) => new Date(now - mins * 60_000).toISOString();
    const decisions: Row[] = [
      dispatchDecision(TENANT_A, {
        id: "d1",
        status: "approved",
        emitted_at: recent(10),
        body: { target_agent_slug: "engineer", intent: "Fix checkout 500" },
      }),
      dispatchDecision(TENANT_A, {
        id: "d2",
        status: "acted",
        emitted_at: recent(20),
        body: { target_agent_slug: "growth-lead", intent: "Referral pilot" },
      }),
      dispatchDecision(TENANT_A, {
        id: "d3",
        status: "approved",
        emitted_at: recent(30),
        body: { target_agent_slug: "operator", intent: "Close AZ gap" },
      }),
      dispatchDecision(TENANT_A, {
        id: "d4",
        status: "approved",
        emitted_at: recent(40),
        body: { target_agent_slug: "pm", intent: "Backlog re-rank" },
      }),
    ];
    const agent_runs: Row[] = [
      { status: "success", tenant_id: TENANT_A, payload: { source_decision_id: "d1" } },
      { status: "running", tenant_id: TENANT_A, payload: { source_decision_id: "d2" } },
      { status: "failed", tenant_id: TENANT_A, payload: { source_decision_id: "d3" } },
    ];

    const d = (await build(
      ctx(TENANT_A, { decisions, agent_runs }),
    )) as Record<string, any>;

    const acct = d.accountability as Array<Record<string, unknown>>;
    const byTarget = Object.fromEntries(acct.map((a) => [a.target, a.state]));
    expect(byTarget.engineer).toBe("delivered");
    expect(byTarget["growth-lead"]).toBe("on_track");
    expect(byTarget.operator).toBe("missed");
    expect(byTarget.pm).toBe("at_risk");
    expect(acct[0].state).toBe("missed");
    expect(acct[acct.length - 1].state).toBe("delivered");
  });

  it("CROSS-TENANT ISOLATION: tenant A's panels never include tenant B rows", async () => {
    const now = Date.now();
    const recent = (mins: number) => new Date(now - mins * 60_000).toISOString();
    const decisions: Row[] = [
      dispatchDecision(TENANT_A, {
        id: "a-1",
        status: "approved",
        emitted_at: recent(5),
        body: { target_agent_slug: "pm", intent: "TENANT-A intent" },
      }),
      dispatchDecision(TENANT_B, {
        id: "b-1",
        status: "approved",
        emitted_at: recent(5),
        body: { target_agent_slug: "engineer", intent: "TENANT-B SECRET intent" },
      }),
      dispatchDecision(TENANT_B, {
        id: "b-2",
        status: "rejected",
        emitted_at: recent(6),
        body: { target_agent_slug: "operator", intent: "TENANT-B rejected" },
      }),
    ];
    const agent_runs: Row[] = [
      { status: "success", tenant_id: TENANT_A, payload: { source_decision_id: "a-1" } },
      { status: "success", tenant_id: TENANT_B, payload: { source_decision_id: "b-1" } },
    ];

    const d = (await build(
      ctx(TENANT_A, { decisions, agent_runs }),
    )) as Record<string, any>;

    const verdicts = d.recent_verdicts as Array<Record<string, unknown>>;
    const acct = d.accountability as Array<Record<string, unknown>>;

    expect(verdicts.map((v) => v.decision_id)).toEqual(["a-1"]);
    expect(JSON.stringify(verdicts)).not.toContain("TENANT-B");
    expect(JSON.stringify(verdicts)).not.toContain("b-1");
    expect(JSON.stringify(verdicts)).not.toContain("b-2");

    expect(acct.map((a) => a.target)).toEqual(["pm"]);
    expect(acct[0].state).toBe("delivered");
    expect(JSON.stringify(acct)).not.toContain("TENANT-B");
  });

  it("redacts email / SSN / card / money from displayed intent (PII + faithfulness gate)", async () => {
    const now = Date.now();
    const decisions: Row[] = [
      dispatchDecision(TENANT_A, {
        id: "d-pii",
        status: "approved",
        emitted_at: new Date(now - 60_000).toISOString(),
        body: {
          target_agent_slug: "support-lead",
          intent:
            "Refund buyer jane@acme.com $4,200 (SSN 123-45-6789, card 4111 1111 1111 1111, call +1 (415) 555-0123)",
        },
      }),
    ];
    const d = (await build(
      ctx(TENANT_A, { decisions, agent_runs: [] }),
    )) as Record<string, any>;
    const intent = (d.recent_verdicts[0] as Record<string, unknown>)
      .intent as string;
    expect(intent).not.toContain("jane@acme.com");
    expect(intent).not.toContain("123-45-6789");
    expect(intent).not.toContain("4111");
    expect(intent).not.toContain("$4,200");
    expect(intent).not.toContain("555-0123");
    expect(intent).toContain("[redacted]");
    expect(intent).toContain("Refund buyer");
  });

  it("EMPTY / first-time: no dispatch decisions → empty verdicts + accountability, never throws", async () => {
    const d = (await build(
      ctx(TENANT_A, { decisions: [], agent_runs: [] }),
    )) as Record<string, any>;
    expect(d.recent_verdicts).toEqual([]);
    expect(d.accountability).toEqual([]);
    expect(d.kpis).toBeDefined();
    expect(d.has_digest).toBe(false);
  });
});
