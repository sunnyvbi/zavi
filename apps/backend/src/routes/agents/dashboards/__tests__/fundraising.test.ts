
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFlag = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock("@/services/fundraising/flag", () => ({
  fundraisingPipelineEnabled: mockFlag.enabled,
}));
const mockSettings = vi.hoisted(() => ({ getBool: vi.fn() }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: mockSettings.getBool,
}));
beforeEach(() => {
  mockFlag.enabled.mockResolvedValue(false);
  mockSettings.getBool.mockResolvedValue(false);
});

import {
  build,
  demoteOffRoundTier1,
  hasAngelSizedCheck,
  orderInvestors,
  rankInvestors,
  scoreInvestor,
  stageFitOf,
  stagesMentioned,
  type InvestorRow,
} from "../fundraising";
import type { DashboardContext } from "../_contract";
import { identityKey } from "@/agents/fundraising/materialize";

function row(over: Partial<InvestorRow>): InvestorRow {
  return {
    firm: "",
    name: "",
    tier: 3,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: "",
    contact_hint: "",
    suggested_message: "",
    source: "",
    source_url: "",
    source_kind: "",
    has_draft: false,
    source_excerpt: "",
    ...over,
  };
}

function makeSb(
  tables: Record<string, unknown[]>,
  eqLog?: Array<[string, unknown]>,
  durableRows?: unknown[],
  rpcLog?: Array<[string, unknown]>,
) {
  let current: string | null = null;
  let eqs: Array<[string, unknown]> = [];
  let ins: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {
    from(t: string) {
      current = t;
      eqs = [];
      ins = [];
      return chain;
    },
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      eqLog?.push([col, val]);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      ins.push([col, vals]);
      return chain;
    },
    order: () => chain,
    rpc: (fn: string, args: unknown) => {
      rpcLog?.push([fn, args]);
      return Promise.resolve({ data: durableRows ?? [], error: null });
    },
    limit: () => chain,
    maybeSingle: () =>
      Promise.resolve({ data: filterRows()[0] ?? null, error: null }),
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: filterRows(), error: null }).then(resolve);
    },
  };
  function filterRows(): unknown[] {
    const applied = eqs.slice();
    const appliedIns = ins.slice();
    return (tables[current ?? ""] ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      return (
        applied.every(([col, val]) =>
          Object.prototype.hasOwnProperty.call(r, col) ? r[col] === val : true,
        ) &&
        appliedIns.every(([col, vals]) =>
          Object.prototype.hasOwnProperty.call(r, col)
            ? vals.includes(r[col])
            : true,
        )
      );
    });
  }
  return chain;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";

function ctx(
  tables: Record<string, unknown[]>,
  opts?: {
    tenantId?: string;
    eqLog?: Array<[string, unknown]>;
    durableRows?: unknown[];
    rpcLog?: Array<[string, unknown]>;
  },
): DashboardContext {
  return {
    tenantId: opts?.tenantId ?? TENANT_A,
    sb: makeSb(tables, opts?.eqLog, opts?.durableRows, opts?.rpcLog),
  } as unknown as DashboardContext;
}

describe("fundraising dashboard builder — investor workbench", () => {
  it("maps the latest run's investors to tier-sorted rows + coverage + CSV", async () => {
    const newest = {
      id: "run-new",
      enqueued_at: "2026-06-13T00:00:00Z",
      parsed: {
        rendered_markdown: "…",
        gated: true,
        investors: [
          {
            firm: "Costanoa Ventures",
            name: "Greg Sands",
            tier: 2,
            focus: "data-moat B2B",
            stage_focus: "Seed",
            check_size: "$2M",
            fit_rationale: "Leads at seed in B2B SaaS.",
            contact_hint: "costanoavc.com",
            suggested_message: "Hi Greg — building Zavi…",
            source: "web",
            source_kind: "investor_directory",
            source_url: "https://costanoavc.com",
            evidence_span:
              "Costanoa Ventures leads seed rounds in data-driven B2B SaaS.",
            evidence_text: "leads seed rounds in data-driven B2B SaaS",
          },
          {
            firm: "Boldstart Ventures",
            tier: 1,
            focus: "B2B infra + agentic AI",
            check_size: "$1-3M",
            fit_rationale: "Pure first-check fund.",
            source: "investor_db",
            evidence_span: "Boldstart — UNVERIFIED db-row text that must NOT leak",
            evidence_text: "also unverified",
          },
          {
            firm: "Bonfire Ventures",
            name: "Mark Mullen",
            tier: 1,
            fit_rationale: "Seed-only B2B.",
            suggested_message: "Hi Mark…",
            source_url: "https://bonfirevc.com",
          },
          {
            firm: "",
            name: "Jane Angel",
            tier: 1,
            fit_rationale: "Angel, ex-operator.",
            suggested_message: "Hi Jane…",
            source: "web",
            source_url: "https://linkedin.com/in/jane",
            evidence_text: "Jane Angel — angel investor and ex-operator",
          },
          { firm: "", name: "", tier: 3, fit_rationale: "blank firm AND name dropped" },
        ],
      },
    };
    const older = {
      id: "run-old",
      enqueued_at: "2026-06-01T00:00:00Z",
      parsed: { rendered_markdown: "…", investors: [{ firm: "X", tier: 3, fit_rationale: "y" }] },
    };

    const d = (await build(
      ctx({
        agent_runs: [newest, older],
        run_artifacts: [{ id: "art-1", run_id: "run-new", filename: "investors.csv" }],
      }),
    )) as Record<string, any>;

    expect(d.latest.run_id).toBe("run-new");
    expect(d.latest.csv).toEqual({ id: "art-1", filename: "investors.csv" });

    const inv = d.latest.investors as Array<Record<string, unknown>>;
    expect(inv).toHaveLength(4);
    expect(inv.map((i) => i.tier)).toEqual([1, 1, 1, 2]);

    expect(inv.some((i) => i.firm === "" && i.name === "Jane Angel")).toBe(true);

    const costanoa = inv.find((i) => i.firm === "Costanoa Ventures")!;
    expect(costanoa.check_size).toBe("$2M");
    expect(costanoa.suggested_message).toBe("Hi Greg — building Zavi…");
    expect(costanoa.has_draft).toBe(true);
    const boldstart = inv.find((i) => i.firm === "Boldstart Ventures")!;
    expect(boldstart.has_draft).toBe(false);

    expect(costanoa.source_kind).toBe("investor_directory");
    expect(boldstart.source_kind).toBe("");

    expect(costanoa.source_excerpt).toBe(
      "Costanoa Ventures leads seed rounds in data-driven B2B SaaS.",
    );
    const jane = inv.find((i) => i.name === "Jane Angel")!;
    expect(jane.source_excerpt).toBe(
      "Jane Angel — angel investor and ex-operator",
    );
    expect(boldstart.source_excerpt).toBe("");

    expect(d.coverage).toEqual({
      total: 4,
      tier1: 3,
      drafts_ready: 3,
      source_backed: 4,
      missing_contact: 1,
    });

    expect(d.runs).toHaveLength(2);
    expect(d.kpis.lists_produced).toBe(2);
  });

  it("surfaces the resolved stage from the gated run onto latest.stage", async () => {
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-stage",
            enqueued_at: "2026-06-23T00:00:00Z",
            parsed: {
              rendered_markdown: "**Stage: Pre-seed** …",
              gated: true,
              stage: "Pre-seed",
              investors: [{ firm: "Acme VC", tier: 1, fit_rationale: "fits" }],
            },
          },
        ],
        run_artifacts: [],
      }),
    )) as Record<string, any>;
    expect(d.latest.stage).toBe("Pre-seed");
  });

  it("ships latest.stage as '' when the gated run carried no stage (back-compat)", async () => {
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-nostage",
            enqueued_at: "2026-06-23T00:00:00Z",
            parsed: {
              rendered_markdown: "…",
              gated: true,
              investors: [{ firm: "Acme VC", tier: 1, fit_rationale: "fits" }],
            },
          },
        ],
        run_artifacts: [],
      }),
    )) as Record<string, any>;
    expect(d.latest.stage).toBe("");
  });

  it("surfaces a persisted active run so reloads keep the generating state", async () => {
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-active",
            tenant_id: TENANT_A,
            status: "running",
            enqueued_at: "2026-06-23T21:15:00Z",
            started_at: "2026-06-23T21:15:10Z",
            payload: { user_message_id: "msg-active" },
          },
          {
            id: "run-old-list",
            tenant_id: TENANT_A,
            status: "success",
            enqueued_at: "2026-06-20T00:00:00Z",
            parsed: {
              rendered_markdown: "…",
              gated: true,
              investors: [{ firm: "Acme VC", tier: 1, fit_rationale: "fits" }],
            },
          },
        ],
        fundraising_round_config: [{ tenant_id: TENANT_A, stage: "Seed" }],
        run_artifacts: [],
      }),
    )) as Record<string, any>;

    expect(d.active_run).toEqual({
      run_id: "run-active",
      status: "running",
      enqueued_at: "2026-06-23T21:15:00Z",
      started_at: "2026-06-23T21:15:10Z",
      target_stage: "Seed",
    });
    expect(d.latest.run_id).toBe("run-old-list");
  });

  it("caps table rows at 150 but reports coverage over the full list", async () => {
    const many = Array.from({ length: 170 }, (_, i) => ({
      firm: `Firm ${i}`,
      tier: 1,
      fit_rationale: "fits",
      suggested_message: "Hi…",
      source_url: "https://x.com",
    }));
    const d = (await build(
      ctx({
        agent_runs: [
          { id: "run-big", enqueued_at: "2026-06-13T00:00:00Z", parsed: { rendered_markdown: "…", gated: true, investors: many } },
        ],
        run_artifacts: [],
      }),
    )) as Record<string, any>;
    expect(d.latest.investors).toHaveLength(150);
    expect(d.coverage.total).toBe(170);
    expect(d.coverage.drafts_ready).toBe(170);
    expect(d.coverage.source_backed).toBe(170);
  });

  it("does NOT surface an ungated (historical) run in the workbench", async () => {
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-historical",
            enqueued_at: "2026-06-01T00:00:00Z",
            parsed: {
              rendered_markdown: "…",
              investors: [{ firm: "Maybe Fake VC", tier: 1, fit_rationale: "ungated" }],
            },
          },
        ],
        run_artifacts: [],
      }),
    )) as Record<string, any>;
    expect(d.latest).toBeNull();
    expect(d.coverage.total).toBe(0);
    expect(d.runs).toHaveLength(1);
    expect(d.kpis.lists_produced).toBe(1);
  });

  it("degrades to an empty library when the agent_runs read fails", async () => {
    const throwingSb = {
      from() {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => {
                      throw new Error("db down");
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      },
    } as unknown as DashboardContext["sb"];
    const d = (await build({
      tenantId: TENANT_A,
      sb: throwingSb,
    } as unknown as DashboardContext)) as Record<string, unknown>;
    expect(d).toEqual({ runs: [] });
  });

  it("applies an explicit tenant_id scope on every dashboard table read", async () => {
    const eqLog: Array<[string, unknown]> = [];
    await build(
      ctx(
        {
          agent_runs: [
            {
              id: "run-t",
              tenant_id: TENANT_A,
              enqueued_at: "2026-06-13T00:00:00Z",
              parsed: {
                rendered_markdown: "…",
                gated: true,
                investors: [{ firm: "Acme VC", tier: 1, fit_rationale: "fits" }],
              },
            },
          ],
          run_artifacts: [
            {
              id: "art-t",
              tenant_id: TENANT_A,
              run_id: "run-t",
              filename: "x.csv",
            },
          ],
        },
        { tenantId: TENANT_A, eqLog },
      ),
    );
    expect(eqLog).toContainEqual(["tenant_id", TENANT_A]);
    expect(eqLog.filter(([col]) => col === "tenant_id")).toHaveLength(8);
  });

  it("CROSS-TENANT ISOLATION: tenant A's dashboard excludes tenant B's runs + artifacts", async () => {
    const TENANT_B = "22222222-2222-2222-2222-222222222222";
    const tables = {
      agent_runs: [
        {
          id: "run-A",
          tenant_id: TENANT_A,
          enqueued_at: "2026-06-13T00:00:00Z",
          parsed: {
            rendered_markdown: "…",
            gated: true,
            investors: [
              {
                firm: "Alpha Capital",
                tier: 1,
                fit_rationale: "A-tenant fit",
                source: "web",
                source_url: "https://alpha.vc",
                evidence_span: "Alpha Capital invests at seed.",
              },
            ],
          },
        },
        {
          id: "run-B",
          tenant_id: TENANT_B,
          enqueued_at: "2026-06-14T00:00:00Z",
          parsed: {
            rendered_markdown: "…",
            gated: true,
            investors: [
              {
                firm: "Beta Capital",
                tier: 1,
                fit_rationale: "B-tenant SECRET fit",
                source: "web",
                source_url: "https://beta.vc",
                evidence_span: "Beta Capital — tenant B private excerpt.",
              },
            ],
          },
        },
      ],
      run_artifacts: [
        { id: "art-A", tenant_id: TENANT_A, run_id: "run-A", filename: "a.csv" },
        { id: "art-B", tenant_id: TENANT_B, run_id: "run-B", filename: "b.csv" },
      ],
    };

    const dA = (await build(
      ctx(tables, { tenantId: TENANT_A }),
    )) as Record<string, any>;

    expect(dA.latest.run_id).toBe("run-A");
    const firms = (dA.latest.investors as Array<Record<string, unknown>>).map(
      (i) => i.firm,
    );
    expect(firms).toEqual(["Alpha Capital"]);
    expect(firms).not.toContain("Beta Capital");
    expect(dA.latest.csv).toEqual({ id: "art-A", filename: "a.csv" });
    expect(JSON.stringify(dA)).not.toContain("tenant B private");
    expect(JSON.stringify(dA)).not.toContain("Beta Capital");
    expect((dA.latest.investors as any[])[0].source_excerpt).toBe(
      "Alpha Capital invests at seed.",
    );

    const dB = (await build(
      ctx(tables, { tenantId: TENANT_B }),
    )) as Record<string, any>;
    expect(dB.latest.run_id).toBe("run-B");
    expect(
      (dB.latest.investors as Array<Record<string, unknown>>).map((i) => i.firm),
    ).toEqual(["Beta Capital"]);
  });

  it("EMPTY / first-time tenant: no runs → empty library, no crash", async () => {
    const d = (await build(
      ctx({ agent_runs: [], run_artifacts: [] }, { tenantId: TENANT_A }),
    )) as Record<string, any>;
    expect(d.latest).toBeNull();
    expect(d.runs).toEqual([]);
    expect(d.kpis.lists_produced).toBe(0);
    expect(d.coverage.total).toBe(0);
  });
});

describe("fundraising dashboard — ranked action queue scorer", () => {
  it("scores a fully-actionable Tier-1 highest (tier + reachable + draft + sourced)", () => {
    const { score, reasons } = scoreInvestor(
      row({
        tier: 1,
        contact_hint: "founder@acme.vc",
        has_draft: true,
        source_url: "https://acme.vc",
        source: "web",
      }),
    );
    expect(score).toBe(100 + 20 + 15 + 10);
    expect(reasons).toEqual(["Tier 1", "Reachable", "Draft ready", "Source-backed"]);
  });

  it("credits a curated-DB row as sourced even with no source_url", () => {
    const { score, reasons } = scoreInvestor(
      row({ tier: 2, source: "investor_db" }),
    );
    expect(score).toBe(60);
    expect(reasons).toEqual(["Tier 2", "Source-backed"]);
  });

  it("a bare Tier-1 scores only the tier weight", () => {
    const { score, reasons } = scoreInvestor(row({ tier: 1 }));
    expect(score).toBe(100);
    expect(reasons).toEqual(["Tier 1"]);
  });

  it("a reachable + draft-ready Tier-1 outranks a bare Tier-1", () => {
    const rich = row({
      firm: "Rich VC",
      tier: 1,
      contact_hint: "x@rich.vc",
      has_draft: true,
      source_url: "https://rich.vc",
    });
    const bare = row({ firm: "Bare VC", tier: 1 });
    const ranked = rankInvestors([bare, rich]);
    expect(ranked.map((r) => r.firm)).toEqual(["Rich VC", "Bare VC"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("any Tier-1 outranks any Tier-2 (even a fully-loaded Tier-2 vs a bare Tier-1)", () => {
    const bareT1 = row({ firm: "Bare T1", tier: 1 });
    const loadedT2 = row({
      firm: "Loaded T2",
      tier: 2,
      contact_hint: "x@t2.vc",
      has_draft: true,
      source_url: "https://t2.vc",
    });
    const ranked = rankInvestors([loadedT2, bareT1]);
    expect(ranked.map((r) => r.firm)).toEqual(["Bare T1", "Loaded T2"]);
  });

  it("caps the queue at 8 (highest-scoring first)", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({
        firm: `Firm ${String(i).padStart(2, "0")}`,
        tier: 1,
        has_draft: true,
        source_url: "https://x.vc",
        contact_hint: "x@x.vc",
      }),
    );
    const ranked = rankInvestors(many);
    expect(ranked).toHaveLength(8);
    expect(ranked[0].firm).toBe("Firm 00");
    expect(ranked[7].firm).toBe("Firm 07");
  });

  it("stable tie-break: equal score → tier asc then firm name asc", () => {
    const ranked = rankInvestors([
      row({ firm: "Zeta", tier: 1 }),
      row({ firm: "Alpha", tier: 1 }),
    ]);
    expect(ranked.map((r) => r.firm)).toEqual(["Alpha", "Zeta"]);
  });

  it("the build payload includes a ranked_queue capped at 8", async () => {
    const investors = Array.from({ length: 10 }, (_, i) => ({
      firm: `Firm ${String(i).padStart(2, "0")}`,
      tier: i % 3 === 0 ? 1 : 2,
      fit_rationale: "fits",
      suggested_message: "Hi…",
      source: "web",
      source_url: "https://x.vc",
      contact_hint: "x@x.vc",
    }));
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-q",
            enqueued_at: "2026-06-13T00:00:00Z",
            parsed: { rendered_markdown: "…", gated: true, investors },
          },
        ],
        run_artifacts: [],
      }),
    )) as Record<string, any>;
    expect(Array.isArray(d.ranked_queue)).toBe(true);
    expect(d.ranked_queue).toHaveLength(8);
    expect(d.ranked_queue[0].tier).toBe(1);
    expect(d.ranked_queue[0].reasons).toContain("Tier 1");
  });
});

describe("fundraising dashboard — #3 outreach-pipeline overlay (flag-gated)", () => {
  const investorsFixture = [
    {
      firm: "Boldstart Ventures",
      name: "Ed Sim",
      tier: 1,
      fit_rationale: "First-check fund.",
      suggested_message: "Hi Ed…",
      source: "web",
      source_url: "https://boldstart.vc",
    },
    {
      firm: "Costanoa Ventures",
      name: "Greg Sands",
      tier: 2,
      fit_rationale: "Seed B2B.",
      source: "web",
      source_url: "https://costanoavc.com",
    },
  ];

  function buildWith(opts: {
    enabled: boolean;
    durableRows?: unknown[];
  }) {
    mockFlag.enabled.mockResolvedValue(opts.enabled);
    return build(
      ctx(
        {
          agent_runs: [
            {
              id: "run-overlay",
              enqueued_at: "2026-06-20T00:00:00Z",
              parsed: {
                rendered_markdown: "…",
                gated: true,
                investors: investorsFixture,
              },
            },
          ],
          run_artifacts: [],
        },
        { durableRows: opts.durableRows },
      ),
    ) as Promise<Record<string, any>>;
  }

  it("pipeline_enabled=TRUE overlays outreach_state + last_sent_at + durable email + identity_key by identityKey(firm,name)", async () => {
    const durable = [
      {
        firm: "Boldstart Ventures",
        name: "Ed Sim",
        email: "ed@boldstart.vc",
        outreach_state: "sent",
        last_sent_at: "2026-06-19T12:00:00Z",
      },
    ];
    const d = await buildWith({ enabled: true, durableRows: durable });

    expect(d.pipeline_enabled).toBe(true);
    const inv = d.latest.investors as Array<Record<string, unknown>>;
    const boldstart = inv.find((i) => i.firm === "Boldstart Ventures")!;
    expect(boldstart.identity_key).toBe(identityKey("Boldstart Ventures", "Ed Sim"));
    expect(boldstart.outreach_state).toBe("sent");
    expect(boldstart.last_sent_at).toBe("2026-06-19T12:00:00Z");
    expect(boldstart.durable_email).toBe("ed@boldstart.vc");

    const costanoa = inv.find((i) => i.firm === "Costanoa Ventures")!;
    expect(costanoa.identity_key).toBe(
      identityKey("Costanoa Ventures", "Greg Sands"),
    );
    expect(costanoa.outreach_state).toBeNull();
    expect(costanoa.last_sent_at).toBeNull();
    expect(costanoa.durable_email).toBeNull();
  });

  it("#4 honest contact count: a durable email makes a row NOT missing-contact even with no hint/url", async () => {
    const noContactRow = [
      { firm: "Quiet Fund", name: "Pat Angel", tier: 1, fit_rationale: "fits" },
    ];
    const durable = [
      {
        firm: "Quiet Fund",
        name: "Pat Angel",
        email: "pat@quiet.fund",
        outreach_state: "queued",
        last_sent_at: null,
      },
    ];
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(
        {
          agent_runs: [
            {
              id: "run-c",
              enqueued_at: "2026-06-20T00:00:00Z",
              parsed: { rendered_markdown: "…", gated: true, investors: noContactRow },
            },
          ],
          run_artifacts: [],
        },
        { durableRows: durable },
      ),
    )) as Record<string, any>;
    expect(d.coverage.missing_contact).toBe(0);
  });

  it("pipeline_enabled=FALSE: no overlay, no extra fields, no rpc — byte-identical payload", async () => {
    const durable = [
      {
        firm: "Boldstart Ventures",
        name: "Ed Sim",
        email: "ed@boldstart.vc",
        outreach_state: "sent",
        last_sent_at: "2026-06-19T12:00:00Z",
      },
    ];
    const d = await buildWith({ enabled: false, durableRows: durable });

    expect(d.pipeline_enabled).toBe(false);
    const inv = d.latest.investors as Array<Record<string, unknown>>;
    const boldstart = inv.find((i) => i.firm === "Boldstart Ventures")!;
    expect(boldstart.identity_key).toBeUndefined();
    expect(boldstart.outreach_state).toBeUndefined();
    expect(boldstart.last_sent_at).toBeUndefined();
    expect(boldstart.durable_email).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("ed@boldstart.vc");
  });
});

describe("fundraising dashboard — investor list reads from the DURABLE table", () => {
  const latestRunInvestors = [
    {
      firm: "Boldstart Ventures",
      name: "Ed Sim",
      tier: 1,
      fit_rationale: "First-check fund.",
      suggested_message: "Hi Ed…",
      source: "web",
      source_url: "https://boldstart.vc",
    },
    {
      firm: "Costanoa Ventures",
      name: "Greg Sands",
      tier: 2,
      fit_rationale: "Seed B2B.",
      source: "web",
      source_url: "https://costanoavc.com",
    },
  ];

  const olderRunInvestors = [
    {
      firm: "Uncork Capital",
      name: "Jeff Clavier",
      tier: 1,
      focus: "seed B2B",
      check_size: "$1-2M",
      fit_rationale: "Seed-only, leads.",
      suggested_message: "Hi Jeff…",
      source: "web",
      source_url: "https://uncorkcapital.com",
    },
  ];

  const durableFive = [
    {
      firm: "Boldstart Ventures",
      name: "Ed Sim",
      email: "ed@boldstart.vc",
      outreach_state: "sent",
      last_sent_at: "2026-07-01T00:00:00Z",
      notes: "First-check fund.",
      draft_body: "Hi Ed…",
      source: "web",
    },
    {
      firm: "Costanoa Ventures",
      name: "Greg Sands",
      email: null,
      outreach_state: "queued",
      last_sent_at: null,
      notes: "Seed B2B.",
      draft_body: null,
      source: "web",
    },
    {
      firm: "Uncork Capital",
      name: "Jeff Clavier",
      email: null,
      outreach_state: "queued",
      last_sent_at: null,
      notes: "Seed-only, leads.",
      draft_body: "Hi Jeff…",
      source: "web",
    },
    {
      firm: "Homebrew",
      name: "Hunter Walk",
      email: "hunter@homebrew.co",
      outreach_state: "replied",
      last_sent_at: "2026-06-28T00:00:00Z",
      notes: "Operator-led seed fund.",
      draft_body: "Hi Hunter…",
      source: "investor_db",
    },
    {
      firm: "",
      name: "Jane Angel",
      email: null,
      outreach_state: "queued",
      last_sent_at: null,
      notes: "Angel, ex-operator.",
      draft_body: null,
      source: "web",
    },
  ];

  function tables(opts?: { withOlderRun?: boolean }) {
    const agent_runs: unknown[] = [
      {
        id: "run-newest",
        tenant_id: TENANT_A,
        enqueued_at: "2026-07-20T00:00:00Z",
        parsed: {
          rendered_markdown: "…",
          gated: true,
          investors: latestRunInvestors,
        },
      },
    ];
    if (opts?.withOlderRun) {
      agent_runs.push({
        id: "run-older",
        tenant_id: TENANT_A,
        enqueued_at: "2026-06-02T00:00:00Z",
        parsed: {
          rendered_markdown: "…",
          gated: true,
          investors: olderRunInvestors,
        },
      });
    }
    return { agent_runs, run_artifacts: [] };
  }

  it("(a) durable rows present → the list is the durable set, not just the newest run's 2", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(tables(), { durableRows: durableFive }),
    )) as Record<string, any>;

    expect(d.coverage.total).toBe(5);
    const inv = d.latest.investors as Array<Record<string, unknown>>;
    expect(inv).toHaveLength(5);
    expect(new Set(inv.map((i) => i.firm || i.name))).toEqual(
      new Set([
        "Boldstart Ventures",
        "Costanoa Ventures",
        "Uncork Capital",
        "Homebrew",
        "Jane Angel",
      ]),
    );
    const tiers = inv.map((i) => i.tier as number);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(tiers[0]).toBe(1);

    const homebrew = inv.find((i) => i.firm === "Homebrew")!;
    expect(homebrew.fit_rationale).toBe("Operator-led seed fund.");
    expect(homebrew.suggested_message).toBe("Hi Hunter…");
    expect(homebrew.has_draft).toBe(true);
    expect(homebrew.tier).toBe(3);
    expect(homebrew.source_url).toBe("");
    expect(homebrew.source_excerpt).toBe("");

    for (const i of inv) {
      expect(i.identity_key).toBe(
        identityKey(i.firm as string, i.name as string),
      );
      expect(i.review_key).toBe(i.identity_key);
    }
    expect(homebrew.outreach_state).toBe("replied");
    expect(homebrew.durable_email).toBe("hunter@homebrew.co");
    expect(d.coverage.missing_contact).toBe(2);
  });

  it("(a2) a durable row the newest run dropped keeps the RICH row from the older gated run", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(tables({ withOlderRun: true }), { durableRows: durableFive }),
    )) as Record<string, any>;

    const inv = d.latest.investors as Array<Record<string, unknown>>;
    const uncork = inv.find((i) => i.firm === "Uncork Capital")!;
    expect(uncork.tier).toBe(1);
    expect(uncork.check_size).toBe("$1-2M");
    expect(uncork.source_url).toBe("https://uncorkcapital.com");
    expect(uncork.focus).toBe("seed B2B");
    expect(inv.filter((i) => i.firm === "Uncork Capital")).toHaveLength(1);
    expect(d.coverage.total).toBe(5);
  });

  it("(b) durable list EMPTY → falls back to the newest gated run's investors", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(tables(), { durableRows: [] }),
    )) as Record<string, any>;

    expect(d.coverage.total).toBe(2);
    const firms = (d.latest.investors as Array<Record<string, unknown>>).map(
      (i) => i.firm,
    );
    expect(firms).toEqual(["Boldstart Ventures", "Costanoa Ventures"]);
  });

  it("(b2) pipeline flag OFF → falls back to the newest gated run even with durable rows", async () => {
    mockFlag.enabled.mockResolvedValue(false);
    const d = (await build(
      ctx(tables(), { durableRows: durableFive }),
    )) as Record<string, any>;

    expect(d.coverage.total).toBe(2);
    expect(JSON.stringify(d)).not.toContain("Homebrew");
    expect(JSON.stringify(d)).not.toContain("hunter@homebrew.co");
  });

  it("(c) TENANT SCOPE: the durable read passes the SERVER-AUTHED tenant as p_tenant_id", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const rpcLog: Array<[string, unknown]> = [];
    await build(ctx(tables(), { durableRows: durableFive, rpcLog }));
    expect(rpcLog).toContainEqual([
      "fundraising_list_investors",
      { p_tenant_id: TENANT_A },
    ]);
    for (const [, args] of rpcLog) {
      expect((args as { p_tenant_id: string }).p_tenant_id).toBe(TENANT_A);
    }

    const TENANT_B = "22222222-2222-2222-2222-222222222222";
    const rpcLogB: Array<[string, unknown]> = [];
    await build(
      ctx(tables(), {
        tenantId: TENANT_B,
        durableRows: durableFive,
        rpcLog: rpcLogB,
      }),
    );
    expect(rpcLogB).toContainEqual([
      "fundraising_list_investors",
      { p_tenant_id: TENANT_B },
    ]);
  });
});

describe("fundraising dashboard — deep-round dossier join", () => {
  const runInvestors = [
    {
      firm: "Benchmark",
      name: "Sarah Tavel",
      tier: 1,
      fit_rationale: "Marketplace hierarchy of needs.",
      source: "web",
      source_url: "https://benchmark.com",
    },
    {
      firm: "Maniv Mobility",
      name: "",
      tier: 2,
      fit_rationale: "Mobility-only mandate.",
      source: "web",
      source_url: "https://maniv.com",
    },
  ];

  function tablesWithDeep(deepRuns: unknown[] = []) {
    return {
      agent_runs: [
        {
          id: "run-src",
          tenant_id: TENANT_A,
          enqueued_at: "2026-07-20T00:00:00Z",
          parsed: { rendered_markdown: "…", gated: true, investors: runInvestors },
        },
        ...deepRuns,
      ],
      run_artifacts: [],
    };
  }

  const benchmarkKey = "benchmark|sarah tavel";

  it("joins a deep dossier onto the matching investor by identity_key", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(
        tablesWithDeep([
          {
            id: "run-deep-1",
            tenant_id: TENANT_A,
            enqueued_at: "2026-07-25T00:00:00Z",
            parsed: {
              rendered_markdown: "…",
              mode: "deep",
              deep: {
                identity_key: benchmarkKey,
                firm: "Benchmark",
                who_they_are: "Partner since 2019.",
                draft: "Sarah — hosts keep 90%+…",
                sources: [{ url: "https://benchmark.com/team", claim: "partner" }],
              },
            },
          },
        ]),
        { durableRows: [] },
      ),
    )) as Record<string, any>;

    const inv = d.latest.investors as Array<Record<string, any>>;
    const benchmark = inv.find((i) => i.firm === "Benchmark")!;
    expect(benchmark.dossier).toBeTruthy();
    expect(benchmark.dossier.who_they_are).toBe("Partner since 2019.");
    expect(benchmark.dossier.draft).toContain("hosts keep 90%+");

    const maniv = inv.find((i) => i.firm === "Maniv Mobility")!;
    expect(maniv.dossier).toBeUndefined();
  });

  it("newest dossier wins when an investor was deep-rounded twice", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(
        tablesWithDeep([
          {
            id: "run-deep-new",
            tenant_id: TENANT_A,
            enqueued_at: "2026-07-28T00:00:00Z",
            parsed: {
              mode: "deep",
              rendered_markdown: "…",
              deep: { identity_key: benchmarkKey, who_they_are: "NEWER" },
            },
          },
          {
            id: "run-deep-old",
            tenant_id: TENANT_A,
            enqueued_at: "2026-07-21T00:00:00Z",
            parsed: {
              mode: "deep",
              rendered_markdown: "…",
              deep: { identity_key: benchmarkKey, who_they_are: "OLDER" },
            },
          },
        ]),
        { durableRows: [] },
      ),
    )) as Record<string, any>;

    const benchmark = (d.latest.investors as Array<Record<string, any>>).find(
      (i) => i.firm === "Benchmark",
    )!;
    expect(benchmark.dossier.who_they_are).toBe("NEWER");
  });

  it("a deep run with no identity_key is ignored, never smeared onto a random row", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(
        tablesWithDeep([
          {
            id: "run-deep-keyless",
            tenant_id: TENANT_A,
            enqueued_at: "2026-07-26T00:00:00Z",
            parsed: {
              mode: "deep",
              rendered_markdown: "…",
              deep: { who_they_are: "orphan dossier, no key" },
            },
          },
        ]),
        { durableRows: [] },
      ),
    )) as Record<string, any>;

    for (const i of d.latest.investors as Array<Record<string, any>>) {
      expect(i.dossier).toBeUndefined();
    }
  });

  it("source/strategy runs are never mistaken for dossiers", async () => {
    mockFlag.enabled.mockResolvedValue(true);
    const d = (await build(
      ctx(
        tablesWithDeep([
          {
            id: "run-strategy",
            tenant_id: TENANT_A,
            enqueued_at: "2026-07-27T00:00:00Z",
            parsed: {
              mode: "strategy",
              rendered_markdown: "…",
              gated: true,
              investors: runInvestors,
              deep: { identity_key: benchmarkKey, who_they_are: "SHOULD NOT APPEAR" },
            },
          },
        ]),
        { durableRows: [] },
      ),
    )) as Record<string, any>;

    for (const i of d.latest.investors as Array<Record<string, any>>) {
      expect(i.dossier).toBeUndefined();
    }
  });
});

describe("fundraising dashboard — round-fit (stage) matching", () => {
  it("does NOT read 'pre-seed' as a seed mention (the substring trap)", () => {
    const m = stagesMentioned("Pre-seed only");
    expect([...m]).toEqual(["Pre-seed"]);
    expect(m.has("Seed")).toBe(false);
  });

  it("reads both rungs when the text really names both", () => {
    const m = stagesMentioned("pre-seed and seed");
    expect(m.has("Pre-seed")).toBe(true);
    expect(m.has("Seed")).toBe(true);
  });

  it("normalizes spelling variants of the same rung", () => {
    for (const s of ["preseed", "Pre Seed", "pre_seed", "PRE-SEED"]) {
      expect(stagesMentioned(s).has("Pre-seed")).toBe(true);
    }
    expect(stagesMentioned("Series B+ growth").has("Series B+")).toBe(true);
    expect(stagesMentioned("seriesa").has("Series A")).toBe(true);
  });

  it("classifies match / adjacent / mismatch", () => {
    expect(stageFitOf("Seed", "seed-stage marketplaces")).toBe("match");
    expect(stageFitOf("Seed", "pre-seed only")).toBe("adjacent");
    expect(stageFitOf("Seed", "Series B and later")).toBe("mismatch");
  });

  it("treats BOTH kinds of silence as unknown, never as mismatch", () => {
    expect(stageFitOf("", "seed")).toBe("unknown");
    expect(stageFitOf("Seed", "")).toBe("unknown");
    expect(stageFitOf("Seed", null)).toBe("unknown");
  });

  it("scores round fit and names it in the reason chips", () => {
    const base = { tier: 1, stage_focus: "seed" };
    const match = scoreInvestor(row(base), "Seed");
    const noStage = scoreInvestor(row(base));
    expect(match.score).toBe(noStage.score + 40);
    expect(match.reasons).toContain("Fits Seed");

    const off = scoreInvestor(row({ tier: 1, stage_focus: "Series B" }), "Seed");
    expect(off.score).toBe(noStage.score - 25);
    expect(off.reasons).toContain("Off-stage for Seed");
  });

  it("an unknown stage_focus scores identically with or without a picked round", () => {
    const r = row({ tier: 1, stage_focus: "" });
    expect(scoreInvestor(r, "Seed").score).toBe(scoreInvestor(r).score);
  });

  it("reorders WITHIN a tier without promoting a lower tier above a higher one", () => {
    const t1off = row({ tier: 1, firm: "A Off", stage_focus: "Series B" });
    const t1fit = row({ tier: 1, firm: "Z Fit", stage_focus: "seed" });
    const t2fit = row({
      tier: 2,
      firm: "B Loaded",
      stage_focus: "seed",
      contact_hint: "p@x.vc",
      has_draft: true,
      source: "investor_db",
    });
    const out = orderInvestors([t1off, t1fit, t2fit], "Seed");
    expect(out.map((i) => i.firm)).toEqual(["Z Fit", "A Off", "B Loaded"]);
  });

  it("orders deterministically and does not mutate its input", () => {
    const input = [
      row({ tier: 1, firm: "Beta" }),
      row({ tier: 1, firm: "Alpha" }),
    ];
    const snapshot = input.map((i) => i.firm);
    const a = orderInvestors(input, "Seed").map((i) => i.firm);
    const b = orderInvestors(input, "Seed").map((i) => i.firm);
    expect(a).toEqual(b);
    expect(a).toEqual(["Alpha", "Beta"]);
    expect(input.map((i) => i.firm)).toEqual(snapshot);
  });

  it("agrees with the ranked queue WITHIN a tier", () => {
    const rows = [
      row({ tier: 1, firm: "Off Stage", stage_focus: "Series B" }),
      row({ tier: 1, firm: "On Stage", stage_focus: "seed" }),
    ];
    const ordered = orderInvestors(rows, "Seed").map((i) => i.firm);
    const ranked = rankInvestors(rows, "Seed").map((i) => i.firm);
    expect(ordered).toEqual(["On Stage", "Off Stage"]);
    expect(ranked).toEqual(ordered);
  });

  it("ledger is tier-first while the queue stays score-first (they diverge on purpose)", () => {
    const t1off = row({ tier: 1, firm: "Off Stage T1", stage_focus: "Series B" });
    const t2fit = row({
      tier: 2,
      firm: "On Stage T2",
      stage_focus: "seed",
      contact_hint: "p@x.vc",
      has_draft: true,
      source: "investor_db",
    });
    expect(scoreInvestor(t2fit, "Seed").score).toBeGreaterThan(
      scoreInvestor(t1off, "Seed").score,
    );
    expect(orderInvestors([t2fit, t1off], "Seed").map((i) => i.firm)).toEqual([
      "Off Stage T1",
      "On Stage T2",
    ]);
    expect(rankInvestors([t1off, t2fit], "Seed").map((i) => i.firm)).toEqual([
      "On Stage T2",
      "Off Stage T1",
    ]);
  });
});

describe("fundraising dashboard — round switch keeps Tier 1 on-stage", () => {
  it("Pre-seed -> Angel: a saved pre-seed fund leaves Tier 1, an angel row stays", async () => {
    const d = (await build(
      ctx({
        agent_runs: [
          {
            id: "run-preseed",
            enqueued_at: "2026-10-20T00:00:00Z",
            parsed: {
              rendered_markdown: "**Stage: Pre-seed**",
              gated: true,
              stage: "Pre-seed",
              investors: [
                {
                  firm: "Preseed Fund",
                  tier: 1,
                  stage_focus: "Pre-seed",
                  focus: "B2B SaaS",
                  fit_rationale: "Pre-seed lead, fits your round",
                  source: "investor_db",
                },
                {
                  firm: "",
                  name: "Jane Angel",
                  tier: 1,
                  stage_focus: "Pre-seed, Seed",
                  focus: "Angel, Solo-Capitalists, AI",
                  fit_rationale: "Writes first checks",
                  source: "investor_db",
                },
              ],
            },
          },
        ],
        fundraising_round_config: [{ tenant_id: TENANT_A, stage: "Angel" }],
        run_artifacts: [],
      }),
    )) as Record<string, any>;

    const inv = d.latest.investors as Array<Record<string, unknown>>;
    const fund = inv.find((i) => i.firm === "Preseed Fund")!;
    const angel = inv.find((i) => i.name === "Jane Angel")!;
    expect(fund.tier).toBe(2);
    expect(fund.fit_rationale).toMatch(/^Moved out of Tier 1: does not fit your Angel round/);
    expect(angel.tier).toBe(1);
    expect(d.coverage.tier1).toBe(1);
  });

  it("Angel keeps a fund row tagged angel/solo-capitalist; other rounds demote only a clear mismatch", () => {
    const tagged = row({ tier: 1, firm: "Solo Cap", focus: "and Solo-Capitalists", check_size: "$0 - $25K" });
    const fund = row({ tier: 1, firm: "Fund", stage_focus: "pre-seed" });
    const partner = row({ tier: 1, firm: "Big VC", focus: "Angel, AI", check_size: "$1M - $3M" });
    expect(
      demoteOffRoundTier1([tagged, fund, partner], "Angel").map((i) => i.tier),
    ).toEqual([1, 2, 2]);
    for (const s of ["$0 - $25K", "$25K - $100K", "$10k-$50k", "$0 - $25K; $1M - $3M", "$10-50K", "$25,000 - $100,000", "$25,000-$100K", "$25 thousand"]) {
      expect(hasAngelSizedCheck(s), s).toBe(true);
    }
    for (const s of ["$0.5M", "$0 - $500K", "$25k-$1M", "$50K - $250K", "$1-3M", "$25k-1M", "$500,000", "up to $1 million", "$50k-$2mm", ""]) {
      expect(hasAngelSizedCheck(s), s).toBe(false);
    }
    const seedAngel = row({ tier: 1, firm: "Solo Cap", focus: "Angel", stage_focus: "Seed", check_size: "$25K - $100K" });
    expect(scoreInvestor(seedAngel, "Angel").reasons).toContain("Fits Angel");

    const seedFund = row({ tier: 1, firm: "Seed", stage_focus: "seed" });
    const growth = row({ tier: 1, firm: "Growth", stage_focus: "Series B" });
    const silent = row({ tier: 1, firm: "Silent" });
    expect(
      demoteOffRoundTier1([seedFund, growth, silent], "Seed").map((i) => i.tier),
    ).toEqual([1, 2, 1]);
    expect(demoteOffRoundTier1([growth], "")[0].tier).toBe(1);
  });
});
