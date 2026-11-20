import { describe, it, expect, vi } from "vitest";

vi.mock("@/agents/content-design/post-run", () => ({
  collectRecommendations: () => ({ recs: [] }),
  resolveContentSeoPublishRepo: async () => ({ owner: "acme", repo: "site" }),
}));

import { build } from "../content-design";
import { DECISION_CLASSES } from "@/agents/content-design/constants";
import type { DashboardContext } from "../_contract";

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  function builder(rows: Row[]) {
    const b: Record<string, unknown> = {
      select: () => b,
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
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    from: (t: string) => builder([...(tables[t] ?? [])]),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function decision(id: string, status: string, tenant_id = TENANT): Row {
  return {
    id,
    tenant_id,
    status,
    decision_class: DECISION_CLASSES[0],
    emitted_at: "2026-10-01T00:00:00Z",
    body: { title: `content: add "${id}"`, files: [{ path: `content/blog/${id}.md`, action: "create", content: "x" }] },
  };
}

describe("content-design dashboard builder", () => {
  it("counts only opened PRs, never approved-but-unopened rows, and never calls any of it published", async () => {
    const decisions = [
      decision("acted-1", "acted"),
      decision("acted-2", "acted"),
      decision("approved-1", "approved"),
      decision("proposed-1", "proposed"),
      decision("other-tenant", "acted", OTHER),
    ];
    const out = (await build({ tenantId: TENANT, sb: makeSb({ decisions, agent_runs: [] }) } as unknown as DashboardContext)) as {
      kpis: Record<string, unknown>;
    };
    expect(out.kpis.prs_opened).toBe(2);
    expect(out.kpis.pending).toBe(1);
    expect(out.kpis).not.toHaveProperty("published");
  });
});
