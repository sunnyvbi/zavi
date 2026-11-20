
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFlag = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock("@/services/fundraising/flag", () => ({
  fundraisingPipelineEnabled: mockFlag.enabled,
}));
const mockSettings = vi.hoisted(() => ({ getBool: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mockSettings.getBool }));

beforeEach(() => {
  mockFlag.enabled.mockResolvedValue(false);
  mockSettings.getBool.mockResolvedValue(false);
});

import { build } from "../fundraising";
import type { DashboardContext } from "../_contract";

const TENANT = "11111111-1111-1111-1111-111111111111";

function makeSb(tables: Record<string, unknown[]>, eqLog?: Array<[string, unknown]>) {
  let current: string | null = null;
  let eqs: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {
    from(t: string) {
      current = t;
      eqs = [];
      return chain;
    },
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      eqLog?.push([col, val]);
      return chain;
    },
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    rpc: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  function rows(): unknown[] {
    const applied = eqs.slice();
    return (tables[current ?? ""] ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      return applied.every(([col, val]) =>
        Object.prototype.hasOwnProperty.call(r, col) ? r[col] === val : true,
      );
    });
  }
  return chain;
}

function ctx(
  runs: unknown[],
  opts: { tenantId?: string; eqLog?: Array<[string, unknown]> } = {},
): DashboardContext {
  return {
    tenantId: opts.tenantId ?? TENANT,
    sb: makeSb({ agent_runs: runs }, opts.eqLog),
  } as unknown as DashboardContext;
}

function investor(firm: string) {
  return {
    firm,
    name: "Ed Sim",
    tier: 1,
    focus: "marketplaces",
    fit_rationale: "fits",
    source: "web",
    source_url: "https://example.vc",
  };
}

function run(
  id: string,
  enqueuedAt: string,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT,
    agent_slug: "fundraising",
    status: "success",
    enqueued_at: enqueuedAt,
    parsed: { rendered_markdown: "…", gated: true, ...parsed },
  };
}

type Payload = {
  latest: {
    run_id: string;
    merge?: { added: number; already_saved: number; dropped: string[] };
  } | null;
};

describe("fundraising dashboard — the merge receipt", () => {
  it("surfaces the newest gated source run's receipt on latest.merge", async () => {
    const p = (await build(
      ctx([
        run("run-new", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
          merge: {
            added: 9,
            already_saved: 3,
            dropped: ["Ghost Capital — couldn't confirm it on a page this run actually fetched"],
          },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest?.run_id).toBe("run-new");
    expect(p.latest?.merge).toEqual({
      added: 9,
      already_saved: 3,
      dropped: ["Ghost Capital — couldn't confirm it on a page this run actually fetched"],
    });
  });

  it("omits merge when the newest gated source run carried none (pre-feature run)", async () => {
    const p = (await build(
      ctx([
        run("run-new", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest).not.toBeNull();
    expect(p.latest).not.toHaveProperty("merge");
  });

  it("NEVER falls through to an older run's receipt — that would describe the wrong query", async () => {
    const p = (await build(
      ctx([
        run("run-new", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
        }),
        run("run-old", "2026-07-01T00:00:00Z", {
          investors: [investor("Boldstart Ventures")],
          merge: { added: 9, already_saved: 3, dropped: [] },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest).not.toHaveProperty("merge");
  });

  it("takes the receipt from an ALL-DROPPED newest run, even though its list is empty", async () => {
    const p = (await build(
      ctx([
        run("run-new", "2026-07-30T00:00:00Z", {
          investors: [],
          merge: {
            added: 0,
            already_saved: 0,
            dropped: ["Ghost Capital — x", "Vapor Ventures — y"],
          },
        }),
        run("run-old", "2026-07-01T00:00:00Z", {
          investors: [investor("Boldstart Ventures")],
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest?.run_id).toBe("run-old");
    expect(p.latest?.merge).toEqual({
      added: 0,
      already_saved: 0,
      dropped: ["Ghost Capital — x", "Vapor Ventures — y"],
    });
  });

  it("a strategy run that IS the visible list suppresses an older source receipt", async () => {
    const p = (await build(
      ctx([
        run("run-strategy", "2026-07-30T12:00:00Z", {
          mode: "strategy",
          investors: [investor("Riverstone Ventures")],
        }),
        run("run-source", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
          merge: { added: 2, already_saved: 1, dropped: [] },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest).not.toHaveProperty("merge");
  });

  it("a strategy run that is NOT the visible list still does not suppress the source receipt", async () => {
    const p = (await build(
      ctx([
        run("run-strategy-empty", "2026-07-30T12:00:00Z", {
          mode: "strategy",
          investors: [],
        }),
        run("run-source", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
          merge: { added: 2, already_saved: 1, dropped: [] },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest?.merge).toEqual({ added: 2, already_saved: 1, dropped: [] });
  });

  it("an UNGATED run is never a receipt source (same leak boundary as its investors)", async () => {
    const p = (await build(
      ctx([
        {
          ...run("run-ungated", "2026-07-30T00:00:00Z", {
            investors: [investor("Riverstone Ventures")],
            merge: { added: 9, already_saved: 3, dropped: [] },
          }),
          parsed: {
            rendered_markdown: "…",
            gated: false,
            investors: [investor("Riverstone Ventures")],
            merge: { added: 9, already_saved: 3, dropped: [] },
          },
        },
        run("run-gated", "2026-07-01T00:00:00Z", {
          investors: [investor("Boldstart Ventures")],
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest).not.toHaveProperty("merge");
  });

  it("rejects a malformed receipt outright instead of repairing it into invented numbers", async () => {
    for (const bad of [
      { added: 9, already_saved: 3 },
      { added: 9, dropped: [] },
      { added: "9", already_saved: 3, dropped: [] },
      { added: -1, already_saved: 3, dropped: [] },
      { added: 9, already_saved: 3, dropped: ["ok", 7] },
      { added: 9, already_saved: 3, dropped: "two" },
      "9 new",
    ]) {
      const p = (await build(
        ctx([
          run("run-new", "2026-07-30T00:00:00Z", {
            investors: [investor("Riverstone Ventures")],
            merge: bad,
          }),
        ]),
      )) as unknown as Payload;
      expect(p.latest, JSON.stringify(bad)).not.toHaveProperty("merge");
    }
  });

  it("a filtered-out drop would understate the count, so a bad entry voids the whole receipt", async () => {
    const p = (await build(
      ctx([
        run("run-new", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
          merge: { added: 1, already_saved: 0, dropped: ["Ghost Capital — x", null] },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest).not.toHaveProperty("merge");
  });

  it("reads runs under an explicit tenant filter (no receipt can cross tenants)", async () => {
    const eqLog: Array<[string, unknown]> = [];
    await build(
      ctx(
        [
          run("run-mine", "2026-07-30T00:00:00Z", {
            investors: [investor("Riverstone Ventures")],
            merge: { added: 1, already_saved: 0, dropped: [] },
          }),
          {
            ...run("run-theirs", "2026-07-31T00:00:00Z", {
              investors: [investor("Foreign Capital")],
              merge: { added: 99, already_saved: 99, dropped: ["leak"] },
            }),
            tenant_id: "22222222-2222-2222-2222-222222222222",
          },
        ],
        { eqLog },
      ),
    );
    expect(eqLog).toContainEqual(["tenant_id", TENANT]);
  });

  it("a foreign tenant's newer receipt never reaches this tenant's payload", async () => {
    const p = (await build(
      ctx([
        {
          ...run("run-theirs", "2026-07-31T00:00:00Z", {
            investors: [investor("Foreign Capital")],
            merge: { added: 99, already_saved: 99, dropped: ["leak"] },
          }),
          tenant_id: "22222222-2222-2222-2222-222222222222",
        },
        run("run-mine", "2026-07-30T00:00:00Z", {
          investors: [investor("Riverstone Ventures")],
          merge: { added: 1, already_saved: 0, dropped: [] },
        }),
      ]),
    )) as unknown as Payload;

    expect(p.latest?.merge).toEqual({ added: 1, already_saved: 0, dropped: [] });
  });
});
