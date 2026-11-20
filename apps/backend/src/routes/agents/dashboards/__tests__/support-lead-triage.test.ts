
import { describe, it, expect } from "vitest";
import { build } from "../support-lead";
import type { DashboardContext } from "../_contract";

type Row = Record<string, unknown>;
function makeSb(
  tables: Record<string, Row[]>,
  opts: { errorOn?: Set<string> } = {},
) {
  function table(name: string) {
    const filters: { col: string; val: unknown }[] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return chain;
      },
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      then(resolve: (v: { data: Row[] | null; error: unknown }) => unknown) {
        if (opts.errorOn?.has(name)) {
          return Promise.resolve({ data: null, error: { message: "boom" } }).then(
            resolve,
          );
        }
        const rows = (tables[name] ?? []).filter((r) =>
          filters.every((f) => r[f.col] === f.val),
        );
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return {
    from(name: string) {
      return table(name);
    },
  };
}

function ctx(
  tenantId: string,
  tables: Record<string, Row[]>,
  opts: { errorOn?: Set<string> } = {},
): DashboardContext {
  return {
    tenantId,
    sb: makeSb(tables, opts),
  } as unknown as DashboardContext;
}

const A = "tenant-aaaa";
const B = "tenant-bbbb";

function triageRun(tenant_id: string, cards: Row[], finished_at: string): Row {
  return {
    tenant_id,
    agent_slug: "support-lead",
    status: "success",
    finished_at,
    parsed: { rendered_markdown: "secret prose", cards },
  };
}

function slackConnector(tenant_id: string): Row {
  return { tenant_id, slug: "slack" };
}

describe("support-lead dashboard — escalation funnel richness", () => {
  it("rolls cards into funnel / severity / specialist routes / confidence", async () => {
    const cardsA: Row[] = [
      {
        signal_ref: "Slack Ev123 / thread 1781.99 / guest jane@example.com",
        class: "support",
        severity: "P2",
        next_step: "auto_resolve",
        specialist_slug: null,
        evidence: ["guest jane@example.com reported a late checkout"],
        confidence: 0.82,
      },
      {
        signal_ref: "Slack Ev456",
        class: "dispute",
        severity: "P0",
        next_step: "route_specialist",
        specialist_slug: "dispute-response",
        evidence: ["chargeback for booking 8842, card ****1234"],
        confidence: 0.9,
      },
      {
        signal_ref: "Slack Ev789",
        class: "other",
        severity: "P1",
        next_step: "escalate_founder",
        specialist_slug: null,
        evidence: ["host wants a policy exception"],
        confidence: 0.45,
      },
    ];

    const d = (await build(
      ctx(A, {
        agent_runs: [triageRun(A, cardsA, "2026-06-20T10:00:00Z")],
        connector_metadata: [slackConnector(A)],
        slack_channels: [],
      }),
    )) as Record<string, any>;

    const t = d.triage;
    expect(t).toBeTruthy();
    expect(t.total_cards).toBe(3);
    expect(t.runs).toBe(1);
    expect(t.funnel).toEqual({
      auto_resolve: 1,
      escalate_founder: 1,
      route_specialist: 1,
      no_op: 0,
    });
    expect(t.severity).toEqual({ P0: 1, P1: 1, P2: 1, P3: 0 });
    expect(t.specialist_routes).toEqual([
      { slug: "dispute-response", count: 1 },
    ]);
    expect(t.low_confidence).toBe(1);
    expect(t.last_triage_at).toBe("2026-06-20T10:00:00Z");

    const json = JSON.stringify(d);
    expect(json).not.toContain("evidence");
    expect(json).not.toContain("signal_ref");
    expect(json).not.toContain("jane@example.com");
    expect(json).not.toContain("****1234");
    expect(json).not.toContain("secret prose");
  });

  it("CROSS-TENANT: tenant A's funnel excludes tenant B's cards + PII", async () => {
    const cardsA: Row[] = [
      {
        signal_ref: "A-sig",
        class: "support",
        severity: "P2",
        next_step: "auto_resolve",
        specialist_slug: null,
        evidence: ["A evidence"],
        confidence: 0.8,
      },
    ];
    const cardsB: Row[] = [
      {
        signal_ref: "B-sig-secret",
        class: "dispute",
        severity: "P0",
        next_step: "route_specialist",
        specialist_slug: "engineer",
        evidence: ["B-secret bob@tenantb.com card ****9999"],
        confidence: 0.3,
      },
      {
        signal_ref: "B-sig-2",
        class: "fraud",
        severity: "P0",
        next_step: "escalate_founder",
        specialist_slug: null,
        evidence: ["B fraud"],
        confidence: 0.95,
      },
    ];

    const tables = {
      agent_runs: [
        triageRun(A, cardsA, "2026-06-20T09:00:00Z"),
        triageRun(B, cardsB, "2026-06-20T11:00:00Z"),
      ],
      connector_metadata: [slackConnector(A), slackConnector(B)],
      slack_channels: [],
    };

    const dA = (await build(ctx(A, tables))) as Record<string, any>;

    expect(dA.triage.total_cards).toBe(1);
    expect(dA.triage.runs).toBe(1);
    expect(dA.triage.funnel.auto_resolve).toBe(1);
    expect(dA.triage.funnel.route_specialist).toBe(0);
    expect(dA.triage.funnel.escalate_founder).toBe(0);
    expect(dA.triage.severity.P0).toBe(0);
    expect(dA.triage.specialist_routes).toEqual([]);

    const jsonA = JSON.stringify(dA);
    expect(jsonA).not.toContain("B-secret");
    expect(jsonA).not.toContain("bob@tenantb.com");
    expect(jsonA).not.toContain("****9999");
    expect(jsonA).not.toContain("B-sig-secret");

    const dB = (await build(ctx(B, tables))) as Record<string, any>;
    expect(dB.triage.total_cards).toBe(2);
    expect(dB.triage.specialist_routes).toEqual([{ slug: "engineer", count: 1 }]);
  });

  it("allowlists specialist_slug — unknown model text buckets to 'other'", async () => {
    const cards: Row[] = [
      {
        signal_ref: "s1",
        class: "payout",
        severity: "P1",
        next_step: "route_specialist",
        specialist_slug: "payout-ops",
        evidence: ["x"],
        confidence: 0.7,
      },
      {
        signal_ref: "s2",
        class: "support",
        severity: "P2",
        next_step: "route_specialist",
        specialist_slug: "dispute-response",
        evidence: ["y"],
        confidence: 0.7,
      },
    ];
    const d = (await build(
      ctx(A, {
        agent_runs: [triageRun(A, cards, "2026-06-20T10:00:00Z")],
        connector_metadata: [slackConnector(A)],
        slack_channels: [],
      }),
    )) as Record<string, any>;
    const routes = d.triage.specialist_routes as { slug: string; count: number }[];
    expect(routes).toContainEqual({ slug: "dispute-response", count: 1 });
    expect(routes).toContainEqual({ slug: "other", count: 1 });
    expect(JSON.stringify(d)).not.toContain("payout-ops");
  });

  it("empty/first-time: zero-count triage is present (not omitted)", async () => {
    const d = (await build(
      ctx(A, {
        agent_runs: [],
        connector_metadata: [slackConnector(A)],
        slack_channels: [],
      }),
    )) as Record<string, any>;
    expect(d.triage).toBeTruthy();
    expect(d.triage.total_cards).toBe(0);
    expect(d.triage.runs).toBe(0);
    expect(d.triage.funnel).toEqual({
      auto_resolve: 0,
      escalate_founder: 0,
      route_specialist: 0,
      no_op: 0,
    });
    expect(d.triage.specialist_routes).toEqual([]);
  });

  it("triage read error → triage:null, pulse still renders", async () => {
    const d = (await build(
      ctx(
        A,
        {
          agent_runs: [],
          connector_metadata: [slackConnector(A)],
          slack_channels: [],
        },
        { errorOn: new Set(["agent_runs"]) },
      ),
    )) as Record<string, any>;
    expect(d.triage).toBeNull();
    expect(d.connected).toBe(true);
  });

  it("triage rides the connect-state path even when Slack is unconnected", async () => {
    const cards: Row[] = [
      {
        signal_ref: "s1",
        class: "support",
        severity: "P3",
        next_step: "no_op",
        specialist_slug: null,
        evidence: ["x"],
        confidence: 0.7,
      },
    ];
    const d = (await build(
      ctx(A, {
        agent_runs: [triageRun(A, cards, "2026-06-20T10:00:00Z")],
        connector_metadata: [],
        slack_channels: [],
      }),
    )) as Record<string, any>;
    expect(d.connected).toBe(false);
    expect(d.triage.total_cards).toBe(1);
    expect(d.triage.funnel.no_op).toBe(1);
  });
});
