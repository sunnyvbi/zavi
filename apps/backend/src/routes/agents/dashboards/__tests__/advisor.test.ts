
import { describe, it, expect } from "vitest";
import { build } from "../advisor";
import type { DashboardContext } from "../_contract";

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  function builder(rows: Row[]) {
    let head = false;
    const b: Record<string, unknown> = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) head = true;
        return b;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return b;
      },
      gte: () => b,
      order: () => b,
      limit: () => b,
      then(
        resolve: (v: {
          data: Row[] | null;
          count: number | null;
          error: null;
        }) => unknown,
      ) {
        return Promise.resolve(
          head
            ? { data: null, count: rows.length, error: null }
            : { data: rows, count: rows.length, error: null },
        ).then(resolve);
      },
    };
    return b;
  }
  return {
    from(t: string) {
      return builder([...(tables[t] ?? [])]);
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  } as Record<string, unknown>;
}

function ctx(tenantId: string, tables: Record<string, Row[]>): DashboardContext {
  return {
    tenantId,
    sb: makeSb(tables),
  } as unknown as DashboardContext;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

function rec(over: Partial<Row>): Row {
  return {
    id: over.id ?? "r-x",
    tenant_id: over.tenant_id ?? TENANT_A,
    title: over.title ?? "Some call",
    confidence: over.confidence ?? "evidence_grounded",
    status: over.status ?? "acted",
    disconfirming_signal: over.disconfirming_signal ?? null,
    resolved_reason: over.resolved_reason ?? null,
    lead_priority: over.lead_priority ?? false,
    resolved_at: over.resolved_at ?? "2026-06-10T00:00:00Z",
    created_at: over.created_at ?? "2026-06-01T00:00:00Z",
    emitted_at: over.emitted_at ?? null,
    decision_class: over.decision_class ?? null,
    ...over,
  };
}

describe("advisor dashboard builder — past-calls track record", () => {
  it("returns track_record counts + resolved rows from advisor_recommendations", async () => {
    const tables = {
      decisions: [],
      advisor_recommendations: [
        rec({ id: "a1", status: "acted", title: "Double down on supply", resolved_reason: "Operator dispatched PM; held up." }),
        rec({ id: "a2", status: "acted", title: "Second acted" }),
        rec({ id: "rj", status: "rejected", title: "Expand to TX", resolved_reason: "Dissent stood; killed." }),
        rec({ id: "st", status: "stale", title: "Pricing experiment", resolved_reason: null }),
        rec({ id: "op", status: "open", title: "Still open" }),
      ],
    };
    const d = (await build(ctx(TENANT_A, tables))) as {
      track_record: { acted: number; rejected: number; stale: number; open: number };
      resolved_recommendations: Array<{ id: string; outcome: string; resolved_reason: string | null }>;
      open_recommendations: Array<{ id: string }>;
    };

    expect(d.track_record.acted).toBe(2);
    expect(d.track_record.rejected).toBe(1);
    expect(d.track_record.stale).toBe(1);
    expect(d.track_record.open).toBe(d.open_recommendations.length);

    const ids = d.resolved_recommendations.map((r) => r.id).sort();
    expect(ids).toEqual(["a1", "a2", "rj", "st"]);
    expect(d.resolved_recommendations.find((r) => r.id === "op")).toBeUndefined();
    expect(d.resolved_recommendations.find((r) => r.id === "a1")?.resolved_reason).toBe(
      "Operator dispatched PM; held up.",
    );
  });

  it("CROSS-TENANT: tenant A's track record excludes tenant B's rows", async () => {
    const tables = {
      decisions: [],
      advisor_recommendations: [
        rec({ id: "A-acted", tenant_id: TENANT_A, status: "acted" }),
        rec({ id: "A-open", tenant_id: TENANT_A, status: "open" }),
        rec({ id: "B-acted", tenant_id: TENANT_B, status: "acted" }),
        rec({ id: "B-rejected", tenant_id: TENANT_B, status: "rejected" }),
        rec({ id: "B-stale", tenant_id: TENANT_B, status: "stale" }),
        rec({ id: "B-open", tenant_id: TENANT_B, status: "open" }),
      ],
    };
    const d = (await build(ctx(TENANT_A, tables))) as {
      track_record: { acted: number; rejected: number; stale: number; open: number };
      resolved_recommendations: Array<{ id: string }>;
      open_recommendations: Array<{ id: string }>;
    };

    expect(d.track_record.acted).toBe(1);
    expect(d.track_record.rejected).toBe(0);
    expect(d.track_record.stale).toBe(0);
    const ids = d.resolved_recommendations.map((r) => r.id);
    expect(ids).toEqual(["A-acted"]);
    expect(ids).not.toContain("B-acted");
    expect(ids).not.toContain("B-rejected");
    expect(ids).not.toContain("B-stale");
    expect(d.open_recommendations.map((r) => r.id)).toEqual(["A-open"]);
  });

  it("scrubs obvious email/phone PII shapes out of resolved_reason", async () => {
    const tables = {
      decisions: [],
      advisor_recommendations: [
        rec({
          id: "p1",
          status: "acted",
          resolved_reason:
            "Operator emailed host@example.com and called +1 415-555-2671 to confirm.",
        }),
      ],
    };
    const d = (await build(ctx(TENANT_A, tables))) as {
      resolved_recommendations: Array<{ resolved_reason: string | null }>;
    };
    const reason = d.resolved_recommendations[0]?.resolved_reason ?? "";
    expect(reason).not.toContain("host@example.com");
    expect(reason).not.toContain("415-555-2671");
    expect(reason).toContain("[redacted]");
  });

  it("empty / first-time tenant → zeroed track record, no throw", async () => {
    const d = (await build(
      ctx(TENANT_A, { decisions: [], advisor_recommendations: [] }),
    )) as {
      track_record: { acted: number; rejected: number; stale: number; open: number };
      resolved_recommendations: unknown[];
    };
    expect(d.track_record).toEqual({ acted: 0, rejected: 0, stale: 0, open: 0 });
    expect(d.resolved_recommendations).toEqual([]);
  });
});

describe("advisor dashboard builder — 14d follow-through denominator", () => {
  function dec(status: string, tenant_id = TENANT_A): Row {
    return { tenant_id, status, emitted_at: "2026-06-10T00:00:00Z" };
  }

  it("emitted_14d counts EVERY decision in the window, not just still-proposed ones", async () => {
    const decisions: Row[] = [
      ...Array.from({ length: 57 }, () => dec("proposed")),
      ...Array.from({ length: 46 }, () => dec("acted")),
      ...Array.from({ length: 10 }, () => dec("expired")),
      ...Array.from({ length: 4 }, () => dec("dispatch_failed")),
      dec("rejected"),
    ];
    const d = (await build(
      ctx(TENANT_A, { decisions, advisor_recommendations: [] }),
    )) as { kpis: { emitted_14d: number; proposed_14d: number; acted_14d: number } };

    expect(d.kpis.emitted_14d).toBe(118);
    expect(d.kpis.acted_14d).toBe(46);
    expect(d.kpis.proposed_14d).toBe(57);
    expect(Math.round((d.kpis.acted_14d / d.kpis.emitted_14d) * 100)).toBe(39);
  });

  it("follow-through can never exceed 100% — acted alone still divides by all emitted", async () => {
    const decisions = [
      ...Array.from({ length: 5 }, () => dec("acted")),
      dec("expired"),
    ];
    const d = (await build(
      ctx(TENANT_A, { decisions, advisor_recommendations: [] }),
    )) as { kpis: { emitted_14d: number; acted_14d: number } };

    expect(d.kpis.emitted_14d).toBe(6);
    const pct = Math.round((d.kpis.acted_14d / d.kpis.emitted_14d) * 100);
    expect(pct).toBe(83);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it("CROSS-TENANT: emitted_14d excludes another tenant's decisions", async () => {
    const decisions = [
      dec("acted", TENANT_A),
      dec("proposed", TENANT_A),
      dec("acted", TENANT_B),
      dec("expired", TENANT_B),
      dec("proposed", TENANT_B),
    ];
    const d = (await build(
      ctx(TENANT_A, { decisions, advisor_recommendations: [] }),
    )) as { kpis: { emitted_14d: number; acted_14d: number } };
    expect(d.kpis.emitted_14d).toBe(2);
    expect(d.kpis.acted_14d).toBe(1);
  });
});
