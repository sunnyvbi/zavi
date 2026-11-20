
import { describe, it, expect } from "vitest";
import { build } from "../engineer";
import type { DashboardContext } from "../_contract";

type Row = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string | null;
  parsed: Record<string, unknown> | null;
  enqueued_at: string | null;
  output_text: string | null;
};

function makeSb(rows: Row[]) {
  const filters: { col: string; val: unknown }[] = [];
  const chain: Record<string, unknown> = {
    from() {
      return chain;
    },
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      const data = rows.filter((r) =>
        filters.every((f) => (r as Record<string, unknown>)[f.col] === f.val),
      );
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return { chain, filters };
}

function ctx(tenantId: string, rows: Row[]): DashboardContext {
  const { chain } = makeSb(rows);
  return { tenantId, sb: chain } as unknown as DashboardContext;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

function prRow(over: Partial<Row> & { id: string; tenant_id: string }): Row {
  return {
    agent_slug: "engineer",
    status: "success",
    enqueued_at: "2026-06-19T00:00:00Z",
    output_text: "Did a thing",
    parsed: {
      pr_url: "https://github.com/acme/repo/pull/1",
      pr_repo: "acme/repo",
      pr_number: 1,
    },
    ...over,
  };
}

describe("engineer dashboard builder — signals + tenant isolation", () => {
  it("surfaces per-PR signals (risk / typecheck / tests) from parsed", async () => {
    const rows: Row[] = [
      prRow({
        id: "run-green",
        tenant_id: TENANT_A,
        parsed: {
          pr_url: "https://github.com/acme/repo/pull/9",
          pr_repo: "acme/repo",
          pr_number: 9,
          risk_class: "low",
          typecheck_ok: true,
          test_results: { passed: 8, failed: 0, output_tail: "secret log tail" },
        },
      }),
    ];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    expect(d.connected).toBe(true);
    const pr = d.prs.find((p: any) => p.number === 9);
    expect(pr.signals).toEqual({
      risk_class: "low",
      typecheck: "green",
      tests: { passed: 8, failed: 0, ran: true },
    });
    expect(JSON.stringify(d)).not.toContain("secret log tail");
  });

  it("treats absent typecheck_ok as not_reported and 0/0 tests as not-run", async () => {
    const rows: Row[] = [
      prRow({
        id: "run-nodeps",
        tenant_id: TENANT_A,
        parsed: {
          pr_url: "https://github.com/acme/repo/pull/3",
          pr_repo: "acme/repo",
          pr_number: 3,
          risk_class: "trivial",
          test_results: { passed: 0, failed: 0, output_tail: "deps not installed" },
        },
      }),
    ];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    const pr = d.prs.find((p: any) => p.number === 3);
    expect(pr.signals.typecheck).toBe("not_reported");
    expect(pr.signals.tests.ran).toBe(false);
    expect(pr.signals.risk_class).toBe("trivial");
  });

  it("flags a red typecheck", async () => {
    const rows: Row[] = [
      prRow({
        id: "run-red",
        tenant_id: TENANT_A,
        parsed: {
          pr_url: "https://github.com/acme/repo/pull/7",
          pr_repo: "acme/repo",
          pr_number: 7,
          typecheck_ok: false,
          test_results: { passed: 1, failed: 2 },
        },
      }),
    ];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    const pr = d.prs.find((p: any) => p.number === 7);
    expect(pr.signals.typecheck).toBe("red");
    expect(pr.signals.tests).toEqual({ passed: 1, failed: 2, ran: true });
  });

  it("NEVER returns another tenant's PRs (tenant A excludes tenant B's rows)", async () => {
    const rows: Row[] = [
      prRow({
        id: "run-A",
        tenant_id: TENANT_A,
        parsed: {
          pr_url: "https://github.com/acme/repo/pull/100",
          pr_repo: "acme/repo",
          pr_number: 100,
          risk_class: "low",
        },
      }),
      prRow({
        id: "run-B",
        tenant_id: TENANT_B,
        parsed: {
          pr_url: "https://github.com/evil/repo/pull/200",
          pr_repo: "evil/repo",
          pr_number: 200,
          risk_class: "medium",
        },
      }),
    ];

    const a = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    const numbersA = a.prs.map((p: any) => p.number);
    expect(numbersA).toContain(100);
    expect(numbersA).not.toContain(200);
    expect(JSON.stringify(a)).not.toContain("evil/repo");

    const b = (await build(ctx(TENANT_B, rows))) as Record<string, any>;
    const numbersB = b.prs.map((p: any) => p.number);
    expect(numbersB).toContain(200);
    expect(numbersB).not.toContain(100);
  });

  it("returns connect-state when the tenant has no engineer runs", async () => {
    const d = (await build(ctx(TENANT_A, []))) as Record<string, unknown>;
    expect(d).toEqual({ connected: false });
  });
});

describe("engineer dashboard builder — unknown merge state", () => {
  const DAY = 86400 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  function pr(
    id: string,
    opts: { days: number; number?: number; merged?: boolean },
  ): Row {
    return prRow({
      id,
      tenant_id: TENANT_A,
      enqueued_at: ago(opts.days),
      parsed: {
        pr_url: `https://github.com/acme/repo/pull/${opts.number ?? 1}`,
        pr_repo: "acme/repo",
        pr_number: opts.number ?? 1,
        ...(opts.merged ? { merged: true } : {}),
      },
    });
  }

  it("no merge event EVER + an old PR → unknown, and it does not nag to merge", async () => {
    const rows = [
      pr("old-1", { days: 45, number: 1552 }),
      pr("old-2", { days: 30, number: 1999 }),
      pr("fresh", { days: 2, number: 2059 }),
    ];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;

    const byNum = new Map(d.prs.map((p: any) => [p.number, p.status]));
    expect(byNum.get(1552)).toBe("unknown");
    expect(byNum.get(1999)).toBe("unknown");
    expect(byNum.get(2059)).toBe("open");

    expect(d.kpis.awaiting_merge).toBe(1);
    expect(d.kpis.unknown_state).toBe(2);

    const nags = d.attention.filter((a: any) =>
      /waiting on your merge/.test(a.title),
    );
    expect(nags).toHaveLength(1);
    expect(nags[0].title).toContain("#2059");
    const lost = d.attention.filter((a: any) =>
      /no merge signal/.test(a.title),
    );
    expect(lost).toHaveLength(1);
    expect(lost[0].title).toContain("2 PRs");
    expect(lost[0].detail).toContain("webhook");
  });

  it("webhook PROVEN (one merge landed) → an old unmerged PR stays open, not unknown", async () => {
    const rows = [
      pr("merged-1", { days: 40, number: 100, merged: true }),
      pr("old-open", { days: 40, number: 101 }),
    ];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    const byNum = new Map(d.prs.map((p: any) => [p.number, p.status]));
    expect(byNum.get(100)).toBe("merged");
    expect(byNum.get(101)).toBe("open");
    expect(d.kpis.unknown_state).toBe(0);
    expect(d.kpis.awaiting_merge).toBe(1);
    expect(d.kpis.merged).toBe(1);
    expect(
      d.attention.filter((a: any) => /no merge signal/.test(a.title)),
    ).toHaveLength(0);
  });

  it("a confirmed merge is never reclassified as unknown, however old", async () => {
    const rows = [pr("m", { days: 400, number: 7, merged: true })];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    expect(d.prs[0].status).toBe("merged");
    expect(d.kpis.merged).toBe(1);
    expect(d.kpis.unknown_state).toBe(0);
  });

  it("no unknown PRs → no 'lost track' card at all", async () => {
    const rows = [pr("fresh", { days: 1, number: 5 })];
    const d = (await build(ctx(TENANT_A, rows))) as Record<string, any>;
    expect(d.kpis.unknown_state).toBe(0);
    expect(
      d.attention.filter((a: any) => /no merge signal/.test(a.title)),
    ).toHaveLength(0);
  });
});
