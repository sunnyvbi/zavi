
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/cgo-blockers", () => ({
  loadBlockerSources: async () => ({}),
  deriveBlockers: () => [],
  rankBlockers: () => [],
  blockerItem: (b: { id: string }) => ({ section: "needs_you", text: String(b.id) }),
}));
import type { Request, Response } from "express";

type Rows = Record<string, Array<Record<string, unknown>>>;
let tables: Rows = {};
let tableErrors: Record<string, string> = {};
let touched: string[] = [];

function makeChain(table: string) {
  const filters: Array<[string, unknown]> = [];
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  const field = (r: Record<string, unknown>, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    if (!m) return r[col];
    const v = (r[m[1]] as Record<string, unknown> | null | undefined)?.[m[2]];
    return v == null ? null : String(v);
  };
  let sort: { col: string; asc: boolean } | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: (col: string, opts?: { ascending?: boolean }) => {
      sort = { col, asc: opts?.ascending !== false };
      return chain;
    },
    contains: () => chain,
    is: () => chain,
    or: (expr: string) => {
      const parts = expr.split(",").map((p) => p.split("."));
      preds.push((r) =>
        parts.some(([col, op, ...rest]) => {
          const v = rest.join(".");
          if (op === "not" && v === "is.null") return (field(r, col) ?? null) !== null;
          return op === "eq" ? field(r, col) === v : v === "{}" ? ((field(r, col) as unknown[] | null) ?? []).length > 0 : field(r, col) !== v;
        }),
      );
      return chain;
    },
    not: (col: string, _op: string, val: unknown) => {
      preds.push((r) => (field(r, col) ?? null) !== val);
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    },
    neq: (col: string, val: unknown) => {
      preds.push((r) => field(r, col) !== val);
      return chain;
    },
    gte: (col: string, val: string) => {
      preds.push((r) => String(field(r, col) ?? "") >= val);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      preds.push((r) => vals.includes(field(r, col)));
      return chain;
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      (chain.limit as (n: number) => Promise<unknown>)(Number.MAX_SAFE_INTEGER).then(ok, bad),
    limit: async (n: number) => {
      if (tableErrors[table]) return { data: null, error: { message: tableErrors[table] } };
      const rows = (tables[table] ?? []).filter(
        (r) => filters.every(([col, val]) => field(r, col) === val) && preds.every((p) => p(r)),
      );
      if (sort) {
        const { col, asc } = sort;
        rows.sort((a, b) => {
          const x = a[col];
          const y = b[col];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      return { data: rows.slice(0, n), error: null };
    },
  };
  return chain;
}

let authResult: { user_id: string; tenant_id: string; access_token: string } | null = {
  user_id: "u-1",
  tenant_id: "t-1",
  access_token: "tok",
};

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));

let roleOk = true;
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, _roles: unknown, res: Response) => {
    if (roleOk) return true;
    res.status(403).json({ error: { code: "forbidden", message: "owner or admin only" } });
    return false;
  }),
}));

const rpcCalls: Array<{ tid: string; name: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: null, error: null };
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantRpc: vi.fn(async (tid: string, name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ tid, name, args });
    return rpcResult;
  }),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    from: (table: string) => {
      touched.push(table);
      return makeChain(table);
    },
  })),
}));

vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  decodeXmlEntities: (s: string) => s.replace(/&apos;/g, "'"),
}));

const recipeWatch: Record<string, string[]> = {};
vi.mock("@/services/channels/recipe", () => ({
  recipeExists: (slug: string) => slug in recipeWatch,
  loadChannelRecipe: (slug: string) => ({
    meta: { watch: { signals: (recipeWatch[slug] ?? []).map((key) => ({ key })) } },
  }),
}));

const settings = vi.hoisted(() => ({
  getBoolSetting: vi.fn(async () => false),
  getBoolSettingStrictResolved: vi.fn(async () => false),
}));
vi.mock("@/services/settings", () => settings);

const autopilotRead = vi.hoisted(() => ({ state: null as null | { enabled: boolean; on_at: string | null } }));
vi.mock("@/services/growth/channel-autorun", async (orig) => ({
  ...((await orig()) as object),
  readAutopilotState: async () => {
    if (!autopilotRead.state) throw new Error("not stated by this test");
    return autopilotRead.state;
  },
}));

const fitNote = vi.hoisted(() => ({ fits: [] as Array<{ channel_slug: string; value: string; line: string }> }));
vi.mock("@/services/growth/strategy-note", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/growth/strategy-note")>()),
  readStrategyNote: vi.fn(async () => ({ id: "n", metadata: { strategy: { channel_fit: fitNote.fits } } })),
}));

import { betResult, getGrowthPlan, GROWTH_PLAN_MAX_ACTIVE_GOALS, needsYouByChannel } from "../growth-plan";
import { MAX_ACTIVE_GOALS } from "@/services/autopilot/goal-limits";
import type { GrowthPlanMetric, GrowthPlanResponse } from "../growth-plan";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

async function call(): Promise<GrowthPlanResponse> {
  const res = mockRes();
  await getGrowthPlan({} as Request, res);
  expect(res.statusCode).toBe(200);
  return res.body as GrowthPlanResponse;
}

function goal(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `g-${Math.random().toString(16).slice(2)}`,
    tenant_id: "t-1",
    objective: "Grow signups",
    target_metric: "weekly signups",
    target_value: 500,
    baseline_value: 400,
    current_value: 469,
    due_date: "2026-12-31",
    status: "active",
    priority: 50,
    source: "founder",
    falsifier: null,
    status_changed_by: null,
    status_changed_at: null,
    ...over,
  };
}

function snapshot(over: Partial<Record<string, unknown>> = {}) {
  return {
    tenant_id: "t-1",
    metric_key: "weekly_signups",
    value: 469,
    status: "measured",
    source: "operator_db",
    window_kind: "rolling_7d",
    window_end: "2026-09-05T00:00:00Z",
    meta: {},
    ...over,
  };
}

beforeEach(() => {
  tables = {};
  tableErrors = {};
  touched = [];
  for (const k of Object.keys(recipeWatch)) delete recipeWatch[k];
  authResult = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
  settings.getBoolSetting.mockClear();
});

describe("goals are not gated on autopilot_enabled", () => {
  it("returns goals when autopilot is DISABLED", async () => {
    tables.autopilot_goals = [goal({ objective: "Founder&apos;s goal" })];

    const body = await call();

    expect(body.goals.items).toHaveLength(1);
    expect(body.goals.items[0].objective).toBe("Founder's goal");
    expect(body.goals.active_count).toBe(1);
    expect(settings.getBoolSetting).not.toHaveBeenCalled();
  });

  it("scopes every read to the authed tenant", async () => {
    tables.autopilot_goals = [
      goal({ tenant_id: "t-1", objective: "mine" }),
      goal({ tenant_id: "t-2", objective: "someone else's" }),
    ];
    const body = await call();
    expect(body.goals.items.map((g) => g.objective)).toEqual(["mine"]);
  });
});

describe("active-goal cap", () => {
  it("reports the SAME cap the write routes enforce (20), and over_cap past it", async () => {
    expect(GROWTH_PLAN_MAX_ACTIVE_GOALS).toBe(MAX_ACTIVE_GOALS);
    expect(GROWTH_PLAN_MAX_ACTIVE_GOALS).toBe(20);
    tables.autopilot_goals = ["one", "two", "three", "four"].map((objective) => goal({ objective }));
    let body = await call();
    expect(body.goals.max_active).toBe(20);
    expect(body.goals.active_count).toBe(4);
    expect(body.goals.over_cap).toBe(false);

    tables.autopilot_goals = Array.from({ length: 21 }, (_, i) => goal({ objective: `goal ${i}` }));
    body = await call();
    expect(body.goals.over_cap).toBe(true);
    expect(body.goals.items).toHaveLength(21);
  });

  it("counts only active goals toward the cap", async () => {
    tables.autopilot_goals = [
      goal({ status: "active" }),
      goal({ status: "paused" }),
      goal({ status: "met" }),
      goal({ status: "missed" }),
    ];
    const body = await call();
    expect(body.goals.active_count).toBe(1);
    expect(body.goals.over_cap).toBe(false);
    expect(body.goals.items).toHaveLength(4);
  });
});

describe("CPA denominator and caveat", () => {
  const cpa = snapshot({
    metric_key: "ads_cpa_7d",
    value: 12.34,
    source: "meta_ads",
    meta: { spend: 3011.2, conversions: 244 },
  });

  it("returns the denominator read off the snapshot meta", async () => {
    tables.tenant_metric_snapshots = [cpa, snapshot()];
    const body = await call();
    const m = body.metrics.find((x) => x.key === "ads_cpa_7d")!;
    expect(m.denominator).toEqual({ spend: 3011.2, conversions: 244 });
  });

  it("does NOT invent a denominator when meta has none", async () => {
    tables.tenant_metric_snapshots = [{ ...cpa, meta: {} }, snapshot()];
    const body = await call();
    expect(body.metrics.find((x) => x.key === "ads_cpa_7d")!.denominator).toBeNull();
  });

  it("adds the caveat only when weekly_signups is also measured", async () => {
    tables.tenant_metric_snapshots = [cpa, snapshot()];
    let body = await call();
    let m = body.metrics.find((x) => x.key === "ads_cpa_7d")!;
    expect(m.caveat).toContain("Meta-attributed");
    expect(m.caveat).toContain("244");
    expect(m.caveat).toContain("469");
    expect(m.caveat).toContain("do not divide into each other");

    tables.tenant_metric_snapshots = [cpa];
    body = await call();
    expect(body.metrics.find((x) => x.key === "ads_cpa_7d")!.caveat).toBeNull();

    tables.tenant_metric_snapshots = [cpa, snapshot({ status: "unavailable", value: null })];
    body = await call();
    expect(body.metrics.find((x) => x.key === "ads_cpa_7d")!.caveat).toBeNull();
  });

  it("gives google_ads_cpa_7d the same treatment", async () => {
    tables.tenant_metric_snapshots = [
      snapshot({
        metric_key: "google_ads_cpa_7d",
        value: 40.5,
        source: "google_ads",
        meta: { spend: 810, conversions: 20 },
      }),
      snapshot(),
    ];
    const body = await call();
    const m = body.metrics.find((x) => x.key === "google_ads_cpa_7d")!;
    expect(m.denominator).toEqual({ spend: 810, conversions: 20 });
    expect(m.caveat).toContain("Google-attributed");
  });

  it("claims no source for a metric it never read", async () => {
    const body = await call();
    const never = body.metrics.find((m) => m.status === "unavailable");
    expect(never).toBeDefined();
    expect(never!.source).toBeNull();
  });

  it("reports a metric with no snapshot as unavailable with a null value", async () => {
    tables.tenant_metric_snapshots = [];
    const body = await call();
    expect(body.metrics.length).toBeGreaterThan(0);
    for (const m of body.metrics) {
      expect(m.status).toBe("unavailable");
      expect(m.value).toBeNull();
      expect(m.window_end).toBeNull();
      expect(m.caveat).toBeNull();
    }
  });
});

describe("channel execution vs metric availability", () => {
  it("a delivered run stays delivered while its metrics read unavailable", async () => {
    recipeWatch.google_ads = ["google_ads_spend_7d", "google_ads_cpa_7d"];
    tables.tenant_channels = [
      {
        tenant_id: "t-1",
        channel_slug: "google_ads",
        last_run_at: "2026-09-04T18:00:00Z",
        work_state: "delivered",
      },
    ];
    tables.tenant_metric_snapshots = [
      snapshot({ metric_key: "google_ads_spend_7d", status: "unavailable", value: null }),
      snapshot({ metric_key: "google_ads_cpa_7d", status: "unavailable", value: null }),
    ];

    const body = await call();
    const ch = body.channels.find((c) => c.slug === "google_ads")!;

    expect(ch.last_run_at).toBe("2026-09-04T18:00:00Z");
    expect(ch.last_run_status).toBe("delivered");
    expect(ch.metric_keys).toEqual(["google_ads_spend_7d", "google_ads_cpa_7d"]);
    expect(ch.metric_availability).toBe("unavailable");
  });

  it("reports measured when at least one watched metric is measured", async () => {
    recipeWatch.meta_ads = ["ads_spend_7d", "ads_cpa_7d"];
    tables.tenant_channels = [
      { tenant_id: "t-1", channel_slug: "meta_ads", last_run_at: null, work_state: "idle" },
    ];
    tables.tenant_metric_snapshots = [
      snapshot({ metric_key: "ads_spend_7d", value: 3011.2, source: "meta_ads" }),
      snapshot({ metric_key: "ads_cpa_7d", status: "unavailable", value: null }),
    ];
    const body = await call();
    const ch = body.channels.find((c) => c.slug === "meta_ads")!;
    expect(ch.metric_availability).toBe("measured");
    expect(ch.last_run_at).toBeNull();
    expect(ch.last_run_status).toBe("idle");
  });

  it("reports none for a channel the metric registry cannot serve", async () => {
    recipeWatch.seo = [];
    tables.tenant_channels = [
      { tenant_id: "t-1", channel_slug: "seo", last_run_at: null, work_state: "idle" },
    ];
    const body = await call();
    const ch = body.channels.find((c) => c.slug === "seo")!;
    expect(ch.metric_keys).toEqual([]);
    expect(ch.metric_availability).toBe("none");
  });
});

describe("channel autorun on the page (channel-autorun.ts)", () => {
  const ON = "2026-10-12T09:00:00.000Z";
  afterEach(() => {
    autopilotRead.state = null;
  });
  const rows = () => [
    { tenant_id: "t-1", channel_slug: "seo", autorun: false, autorun_set_by: "plan" },
    { tenant_id: "t-1", channel_slug: "meta_ads", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-01T00:00:00Z" },
    { tenant_id: "t-1", channel_slug: "email_marketing", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00Z" },
    { tenant_id: "t-1", channel_slug: "chatgpt_ads", autorun: true, autorun_set_by: "founder" },
  ];

  it("under Autopilot: every channel on except the founder's ask-first since the ON and ChatGPT without consent", async () => {
    autopilotRead.state = { enabled: true, on_at: ON };
    tables.tenant_channels = rows();
    const body = await call();
    const on = Object.fromEntries(body.channels.map((c) => [c.slug, c.autorun]));
    expect(on).toEqual({ seo: true, meta_ads: true, email_marketing: false, chatgpt_ads: false });
  });

  it("Autopilot off: the stored switch, as before", async () => {
    autopilotRead.state = { enabled: false, on_at: null };
    tables.tenant_channels = rows();
    const body = await call();
    const on = Object.fromEntries(body.channels.map((c) => [c.slug, c.autorun]));
    expect(on).toEqual({ seo: false, meta_ads: false, email_marketing: false, chatgpt_ads: false });
  });
});

describe("retired channels", () => {
  it("a retired channel still marked in plan is not on the page", async () => {
    tables.tenant_channels = [
      { tenant_id: "t-1", channel_slug: "blog", plan_selected: true, plan_selected_set_by: "founder" },
      { tenant_id: "t-1", channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan" },
    ];
    const body = await call();
    expect(body.channels.map((c) => c.slug)).toEqual(["seo"]);
  });
});

describe("empty and degraded states", () => {
  it("returns plan: null without throwing when the tenant has no plan", async () => {
    tables.growth_plan = [];
    tables.autopilot_goals = [goal()];

    const body = await call();

    expect(body.plan).toBeNull();
    expect(body.bets).toEqual([]);
    expect(body.changes).toEqual([]);
    expect(body.goals.items).toHaveLength(1);
    expect(body.metrics.length).toBeGreaterThan(0);
    expect(touched).not.toContain("growth_plan_bets");
  });

  it("returns the live plan and its bets when one exists", async () => {
    tables.growth_plan = [
      {
        id: "p-1",
        tenant_id: "t-1",
        objective: "500 signups a week",
        north_star_metric: "weekly_signups",
        constraint_statement: "Nothing has ever run",
        constraint_confidence: "low",
        status: "live",
        version: 2,
        updated_at: "2026-09-06T10:00:00Z",
      },
      {
        id: "p-0",
        tenant_id: "t-1",
        objective: "old",
        status: "superseded",
        version: 1,
        updated_at: "2026-08-01T10:00:00Z",
        north_star_metric: null,
        constraint_statement: null,
        constraint_confidence: null,
      },
    ];
    tables.growth_plan_bets = [
      {
        id: "b-1",
        tenant_id: "t-1",
        plan_id: "p-1",
        channel_slug: "google_ads",
        intent: "Cut wasted spend",
        expected_effect: "CPA down 20%",
        falsifier: "CPA flat after two weeks",
        status: "proposed",
        rejected_reason: null,
        priority: 80,
      },
      { id: "b-9", tenant_id: "t-1", plan_id: "p-0", intent: "old bet", falsifier: "x", status: "superseded", priority: 10, channel_slug: null, expected_effect: null, rejected_reason: null },
    ];

    const body = await call();

    expect(body.plan?.id).toBe("p-1");
    expect(body.plan?.version).toBe(2);
    expect(body.plan?.constraint_confidence).toBe("low");
    expect(body.bets.map((b) => b.id)).toEqual(["b-1"]);
    expect(body.bets[0].falsifier).toBe("CPA flat after two weeks");
  });

  it("degrades one failed section without failing the page", async () => {
    tableErrors.growth_plan = "boom";
    tables.autopilot_goals = [goal()];
    const body = await call();
    expect(body.plan).toBeNull();
    expect(body.goals.items).toHaveLength(1);
    expect(body.unreadable).toContain("plan");
  });
});

describe("an unreadable section is never reported as an empty one", () => {
  it("names goals as unreadable instead of reporting zero goals", async () => {
    tableErrors.autopilot_goals = 'column autopilot_goals.falsifier does not exist';
    const body = await call();
    expect(body.goals.items).toHaveLength(0);
    expect(body.goals.active_count).toBe(0);
    expect(body.unreadable).toContain("goals");
  });

  it("distinguishes a genuinely empty tenant from a broken read", async () => {
    tables.autopilot_goals = [];
    const empty = await call();
    expect(empty.goals.items).toHaveLength(0);
    expect(empty.unreadable).toEqual([]);

    tableErrors.autopilot_goals = "boom";
    const broken = await call();
    expect(broken.goals.items).toHaveLength(0);
    expect(broken.unreadable).toContain("goals");
  });

  it("names metrics when a single metric read fails", async () => {
    tableErrors.tenant_metric_snapshots = "boom";
    const body = await call();
    expect(body.unreadable).toContain("metrics");
  });

  it("names channels when the channel read fails", async () => {
    tableErrors.tenant_channels = "boom";
    const body = await call();
    expect(body.channels).toHaveLength(0);
    expect(body.unreadable).toContain("channels");
  });

  it("reports EVERY failed section, not just the first", async () => {
    tableErrors.autopilot_goals = "boom";
    tableErrors.tenant_channels = "boom";
    const body = await call();
    expect(body.unreadable).toEqual(expect.arrayContaining(["goals", "channels"]));
  });

  it("does not leak one request's failures into the next", async () => {
    tableErrors.autopilot_goals = "boom";
    const first = await call();
    expect(first.unreadable).toContain("goals");

    delete tableErrors.autopilot_goals;
    tables.autopilot_goals = [goal()];
    const second = await call();
    expect(second.unreadable).toEqual([]);
    expect(second.goals.items).toHaveLength(1);
  });

  it("reports nothing unreadable on a fully healthy read", async () => {
    const body = await call();
    expect(body.unreadable).toEqual([]);
  });

  it("401s without auth", async () => {
    authResult = null;
    const res = mockRes();
    await getGrowthPlan({} as Request, res);
    expect(res.statusCode).toBe(401);
  });
});

describe("legacy strategy fallback", () => {
  const acceptedNote = (over: Record<string, unknown> = {}) => ({
    tenant_id: "t-1",
    note_type: "growth_strategy",
    updated_at: "2026-09-01T00:00:00Z",
    metadata: {
      accepted: true,
      strategy: {
        north_star: { metric: "host activation rate", why: "w", provenance: "p" },
        constraint: {
          statement: "demand routing, not supply",
          lever_family: "demand",
          evidence: "e",
          confidence: "medium",
        },
        channel_bets: [],
        goal: null,
        gaps: [],
        unmeasured: [],
      },
    },
    ...over,
  });

  it("reads the accepted strategy when no typed plan row exists", async () => {
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan).not.toBeNull();
    expect(body.plan!.source).toBe("legacy");
    expect(body.plan!.constraint_statement).toBe("demand routing, not supply");
    expect(body.plan!.constraint_confidence).toBe("medium");
    expect(body.plan!.id).toBeNull();
  });

  it("serves the plan's metric as the north star, and the goal's as the goal's", async () => {
    tables.growth_plan = [
      {
        tenant_id: "t-1",
        status: "live",
        id: "p-1",
        objective: "Book 30 parent inquiries in the next 90 days",
        north_star_metric: "enrolled_children",
        constraint_statement: "c",
        constraint_confidence: "high",
        version: 1,
        updated_at: "2026-09-06T00:00:00Z",
      },
    ];
    tables.autopilot_goals = [
      goal({ objective: "Book 30 parent inquiries", target_metric: "parent_inquiries" }),
    ];
    const body = await call();
    expect(body.plan!.north_star_metric).toBe("enrolled_children");
    expect(body.goals.items[0].target_metric).toBe("parent_inquiries");
  });

  it("serves the lever family on a TYPED plan, read from the strategy note", async () => {
    tables.growth_plan = [
      {
        tenant_id: "t-1",
        status: "live",
        id: "p-1",
        objective: "o",
        north_star_metric: "weekly_signups",
        constraint_statement: "c",
        constraint_confidence: "high",
        version: 1,
        updated_at: "2026-09-06T00:00:00Z",
      },
    ];
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan!.source).toBe("typed");
    expect(body.plan!.constraint_lever_family).toBe("demand");
  });

  it("leaves the lever family null when the note cannot be read, and says nothing", async () => {
    tables.growth_plan = [
      {
        tenant_id: "t-1",
        status: "live",
        id: "p-1",
        objective: "o",
        target_metric: "weekly_signups",
        constraint_statement: "c",
        constraint_confidence: "high",
        version: 1,
        updated_at: "2026-09-06T00:00:00Z",
      },
    ];
    tableErrors.memory_note = "boom";
    const body = await call();
    expect(body.plan!.constraint_lever_family).toBeNull();
    expect(body.unreadable).not.toContain("plan");
  });

  it("prefers the typed row and never falls back when one exists", async () => {
    tables.growth_plan = [
      {
        tenant_id: "t-1",
        status: "live",
        id: "p-1",
        objective: "typed objective",
        target_metric: "weekly_signups",
        constraint_statement: "typed constraint",
        constraint_confidence: "high",
        version: 2,
        updated_at: "2026-09-06T00:00:00Z",
      },
    ];
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan!.source).toBe("typed");
    expect(body.plan!.objective).toBe("typed objective");
  });

  it("serves the founder's diagnosis and agreement, a stopped channel, and each bet's result (Growth J6)", async () => {
    tables.growth_plan = [
      {
        tenant_id: "t-1",
        status: "live",
        id: "p-1",
        objective: "o",
        constraint_statement: "Zavi's guess",
        constraint_confidence: "low",
        founder_constraint: "Hosts cancel too often",
        founder_constraint_at: "2026-10-26T00:00:00Z",
        constraint_agreed_at: null,
        version: 3,
        updated_at: "2026-10-26T00:00:00Z",
      },
    ];
    tables.growth_plan_bets = [
      { tenant_id: "t-1", plan_id: "p-1", id: "b-1", channel_slug: "seo", intent: "rank", falsifier: "no lift", status: "accepted", sort_order: 1 },
    ];
    tables.tenant_channels = [{ tenant_id: "t-1", channel_slug: "geo", plan_selected: false, plan_selected_set_by: "founder_stopped" }];
    const body = await call();
    expect(body.plan).toMatchObject({ founder_constraint: "Hosts cancel too often", founder_constraint_at: "2026-10-26T00:00:00Z", constraint_agreed_at: null });
    expect(body.channels.find((c) => c.slug === "geo")?.plan_selected_set_by).toBe("founder_stopped");
    expect(body.bets[0].result).toMatchObject({ label: "unmeasured" });
  });

  it("rates each channel with the strategy's fit, a live bet always high", async () => {
    fitNote.fits = [{ channel_slug: "seo", value: "low", line: "few searches" }, { channel_slug: "geo", value: "medium", line: "some lift" }];
    tables.growth_plan = [{ tenant_id: "t-1", status: "live", id: "p-1", objective: "o", constraint_statement: "c", version: 1, updated_at: "2026-10-26T00:00:00Z" }];
    tables.growth_plan_bets = [{ tenant_id: "t-1", plan_id: "p-1", id: "b-1", channel_slug: "seo", intent: "rank", rationale: "search intent is high", falsifier: "no lift", status: "accepted", sort_order: 1 }];
    tables.tenant_channels = [
      { tenant_id: "t-1", channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan" },
      { tenant_id: "t-1", channel_slug: "geo", plan_selected: false },
      { tenant_id: "t-1", channel_slug: "pr", plan_selected: false },
    ];
    const body = await call();
    const fit = (slug: string) => body.channels.find((c) => c.slug === slug)?.fit;
    expect(fit("seo")).toEqual({ value: "high", line: "search intent is high" });
    expect(fit("geo")).toEqual({ value: "medium", line: "some lift" });
    expect(fit("pr")).toBeNull();
    fitNote.fits = [];
  });

  it("SURFACES an unaccepted draft, flagged pending, rather than hiding it", async () => {
    tables.memory_note = [
      acceptedNote({ metadata: { ...acceptedNote().metadata, accepted: false } }),
    ];
    const body = await call();
    expect(body.plan).not.toBeNull();
    expect(body.plan!.pending_acceptance).toBe(true);
    expect(body.plan!.source).toBe("legacy");
  });

  it("marks an ACCEPTED strategy as not pending", async () => {
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan!.pending_acceptance).toBe(false);
  });

  it("ignores a note whose strategy is missing its spine", async () => {
    tables.memory_note = [
      acceptedNote({ metadata: { accepted: true, strategy: { north_star: {}, constraint: {} } } }),
    ];
    const body = await call();
    expect(body.plan).toBeNull();
  });

  it("names plan unreadable when the legacy read itself fails", async () => {
    tableErrors.memory_note = "boom";
    const body = await call();
    expect(body.plan).toBeNull();
    expect(body.unreadable).toContain("plan");
  });

  it("serves the legacy plan when the TYPED read fails, and does not cry unreadable", async () => {
    tableErrors.growth_plan = "relation \"growth_plan\" does not exist";
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan).not.toBeNull();
    expect(body.plan!.source).toBe("legacy");
    expect(body.unreadable).not.toContain("plan");
  });

  it("still names plan unreadable when BOTH stores fail", async () => {
    tableErrors.growth_plan = "boom";
    tableErrors.memory_note = "boom";
    const body = await call();
    expect(body.plan).toBeNull();
    expect(body.unreadable).toContain("plan");
  });

  it("carries no bets across — a legacy bet has no falsifier", async () => {
    tables.memory_note = [acceptedNote()];
    const body = await call();
    expect(body.plan!.source).toBe("legacy");
    expect(body.bets).toHaveLength(0);
  });
});

describe("the handler takes the newest row, not the first one", () => {
  it("reads the LATEST snapshot when a metric has several", async () => {
    tables.tenant_metric_snapshots = [
      snapshot({ metric_key: "weekly_signups", value: 100, window_end: "2026-08-01" }),
      snapshot({ metric_key: "weekly_signups", value: 469, window_end: "2026-09-06" }),
      snapshot({ metric_key: "weekly_signups", value: 300, window_end: "2026-08-20" }),
    ];
    const body = await call();
    const m = body.metrics.find((x) => x.key === "weekly_signups");
    expect(m!.value).toBe(469);
    expect(m!.window_end).toBe("2026-09-06");
  });

  it("reads the LATEST live plan when several rows exist", async () => {
    const base = {
      tenant_id: "t-1",
      status: "live",
      target_metric: "weekly_signups",
      constraint_statement: "c",
      constraint_confidence: "high",
    };
    tables.growth_plan = [
      { ...base, id: "old", objective: "older", version: 1, created_at: "2026-08-01", updated_at: "2026-08-01" },
      { ...base, id: "new", objective: "newer", version: 2, created_at: "2026-09-06", updated_at: "2026-09-06" },
    ];
    const body = await call();
    expect(body.plan!.objective).toBe("newer");
  });
});

describe("goal_work: what cgo is doing per goal", () => {
  const card = (over: Record<string, unknown>) => ({
    tenant_id: "t-1",
    decision_class: "cgo.dispatch-specialist",
    emitted_at: new Date().toISOString(),
    ...over,
  });

  it("carries the status line and every move with its state; a waiting card shows whatever its age", async () => {
    const g = goal({ status: "active", cgo_status_line: "6 of 20 signups" });
    tables.autopilot_goals = [g];
    tables.decisions = [
      card({ id: "waiting-old", status: "proposed", emitted_at: "2025-01-01T00:00:00Z", body: { goal_id: g.id, target_agent_slug: "seo", intent: "Fix titles" } }),
      card({ id: "refused", status: "dispatch_failed", body: { goal_id: g.id, target_agent_slug: "engineer", intent: "Fix hero" } }),
      card({ id: "ran", status: "approved", body: { goal_id: g.id, target_agent_slug: "reddit_organic", intent: "Post" } }),
      card({ id: "other-tenant", tenant_id: "t-2", status: "proposed", body: { goal_id: g.id, target_agent_slug: "seo", intent: "x" } }),
    ];
    tables.agent_runs = [{ id: "r1", tenant_id: "t-1", status: "success", payload: { source_decision_id: "ran" } }];
    const body = await call();
    const w = body.goal_work[g.id as string];
    expect(w.status_line).toBe("6 of 20 signups");
    const states = Object.fromEntries(w.moves.map((m) => [m.decision_id, m.state]));
    expect(states).toEqual({ "waiting-old": "waiting", refused: "failed", ran: "done" });
    expect(body.unreadable).not.toContain("goal_work");
  });

  it("a failed read marks only goal_work unreadable; the goals still come back", async () => {
    tables.autopilot_goals = [goal({ status: "active" })];
    tableErrors.decisions = "boom";
    const body = await call();
    expect(body.unreadable).toContain("goal_work");
    expect(body.unreadable).not.toContain("goals");
    expect(body.goals.items).toHaveLength(1);
  });
});

describe("head_of_growth: cgo's note, autopilot, undo", () => {
  it("shows the latest note the founder should see: skips an alarm note that changed nothing", async () => {
    settings.getBoolSettingStrictResolved.mockResolvedValueOnce(true);
    const g = goal({ status: "active", cgo_undo: { why: "Behind pace.", at: "2026-09-26T12:00:00Z", prev: { objective: "Get 20 signups" } } });
    tables.autopilot_goals = [g];
    tables.cgo_notes = [
      { tenant_id: "t-1", kind: "alarm", saw: ["quiet"], changed: [], would_change: [], need: [], created_at: "2026-09-26T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
      { tenant_id: "t-1", kind: "scheduled", saw: ["on pace"], changed: ["Paused Reddit. x"], would_change: [], need: [], created_at: "2026-09-25T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
      { tenant_id: "t-2", kind: "scheduled", saw: ["other tenant"], changed: [], would_change: [], need: [], created_at: "2026-09-26T11:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
    ];
    const body = await call();
    expect(body.head_of_growth.autopilot).toBe(true);
    expect(body.head_of_growth.note?.saw).toEqual(["on pace"]);
    expect(body.head_of_growth.undoable).toEqual([{ goal_id: g.id, why: "Behind pace.", at: "2026-09-26T12:00:00Z", prev_objective: "Get 20 signups" }]);
    expect(body.unreadable).not.toContain("head_of_growth");
  });

  it("a flood of notes with nothing new never hides the last note that had news; an empty check-in is never shown", async () => {
    settings.getBoolSettingStrictResolved.mockResolvedValueOnce(true);
    tables.autopilot_goals = [];
    const quiet = Array.from({ length: 25 }, (_, i) => ({
      tenant_id: "t-1", kind: "alarm", saw: ["quiet"], changed: [], would_change: [], need: [],
      created_at: `2026-09-26T${String(i % 24).padStart(2, "0")}:30:00Z`, next_review_at: "2026-10-01T00:00:00Z",
    }));
    tables.cgo_notes = [
      ...quiet,
      { tenant_id: "t-1", kind: "scheduled", saw: ["empty check-in"], changed: [], would_change: [], need: [], created_at: "2026-09-25T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
      { tenant_id: "t-1", kind: "alarm", saw: ["on pace"], changed: [], would_change: [], need: ["Keep Reddit?"], created_at: "2026-09-24T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
    ];
    const body = await call();
    expect(body.head_of_growth.note?.saw).toEqual(["on pace"]);
  });

  it("a new note hands its questions over apart from the Left-for-you lines; an old note keeps need whole with no questions key", async () => {
    settings.getBoolSettingStrictResolved.mockResolvedValueOnce(true);
    tables.autopilot_goals = [];
    const need = ["Keep Reddit? If I don't hear back by Oct 3, I'll pause Reddit.", "Left for you: Card A, because it is your call."];
    tables.cgo_notes = [
      { tenant_id: "t-1", kind: "scheduled", saw: [], changed: [], would_change: [], need, questions: [need[0]], created_at: "2026-09-26T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
    ];
    let body = await call();
    expect(body.head_of_growth.note?.questions).toEqual([need[0]]);
    expect(body.head_of_growth.note?.need).toEqual([need[1]]);

    settings.getBoolSettingStrictResolved.mockResolvedValueOnce(true);
    tables.cgo_notes = [
      { tenant_id: "t-1", kind: "scheduled", saw: [], changed: [], would_change: [], need, questions: null, created_at: "2026-09-26T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
    ];
    body = await call();
    expect(body.head_of_growth.note?.need).toEqual(need);
    expect(body.head_of_growth.note).not.toHaveProperty("questions");
  });

  it("a failed read marks only head_of_growth unreadable", async () => {
    tables.autopilot_goals = [goal({ status: "active" })];
    tableErrors.cgo_notes = "boom";
    const body = await call();
    expect(body.unreadable).toEqual(["head_of_growth"]);
    expect(body.goals.items).toHaveLength(1);
  });
});

describe("constraint_conflicts (the contradiction card, linked at the source)", () => {
  it("only a flagged, ruled-out hypothesis on an ACTIVE goal; problem and the flag ride on every hypothesis", async () => {
    const active = goal({ status: "active" });
    const done = goal({ status: "achieved" });
    tables.autopilot_goals = [active, done];
    tables.decisions = [];
    tables.growth_plan = [{ id: "p-1", tenant_id: "t-1", objective: "o", north_star_metric: "m", constraint_statement: "Too few visitors", constraint_confidence: "low", status: "live", version: 1, updated_at: "2026-09-27T00:00:00Z" }];
    tables.cgo_hypotheses = [
      { id: "h-flag-ruled", tenant_id: "t-1", goal_id: active.id, problem: "traffic", claim: "Too few visitors", status: "ruled_out", rank: 1, evidence: [], restates_plan_constraint: true, plan_constraint_marked_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" },
      { id: "h-flag-open", tenant_id: "t-1", goal_id: active.id, problem: "offer", claim: "Price", status: "testing", rank: 2, evidence: [], restates_plan_constraint: true, plan_constraint_marked_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" },
      { id: "h-unflagged-ruled", tenant_id: "t-1", goal_id: active.id, problem: "conversion", claim: "Form", status: "ruled_out", rank: 3, evidence: [], restates_plan_constraint: false, updated_at: "2026-09-28T00:00:00Z" },
      { id: "h-done-goal", tenant_id: "t-1", goal_id: done.id, problem: "traffic", claim: "Too few visitors", status: "ruled_out", rank: 1, evidence: [], restates_plan_constraint: true, plan_constraint_marked_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" },
      { id: "h-other-tenant", tenant_id: "t-2", goal_id: active.id, problem: "traffic", claim: "Other", status: "ruled_out", rank: 1, evidence: [], restates_plan_constraint: true, plan_constraint_marked_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" },
    ];
    const body = await call();
    expect(body.constraint_conflicts).toEqual([{ goal_id: active.id, hypothesis_id: "h-flag-ruled", claim: "Too few visitors", kept_at: null }]);
    const hs = body.goal_work[active.id as string].hypotheses;
    expect(hs.find((h) => h.id === "h-flag-ruled")).toMatchObject({ problem: "traffic", restates_plan_constraint: true });
    expect(hs.find((h) => h.id === "h-unflagged-ruled")).toMatchObject({ problem: "conversion", restates_plan_constraint: false });
  });

  it("no flagged ruled-out hypothesis: an empty list, never inferred from text", async () => {
    const g = goal({ status: "active" });
    tables.autopilot_goals = [g];
    tables.decisions = [];
    tables.cgo_hypotheses = [
      { id: "h", tenant_id: "t-1", goal_id: g.id, problem: "traffic", claim: "Too few visitors", status: "ruled_out", rank: 1, evidence: [], restates_plan_constraint: false, updated_at: "2026-09-28T00:00:00Z" },
    ];
    expect((await call()).constraint_conflicts).toEqual([]);
  });
});

describe("goalHypotheses (hypothesis tracker)", () => {
  it("confirmed first, then testing, then to test, then ruled out; evidence newest first, only judged entries", async () => {
    const { goalHypotheses } = await import("../growth-plan");
    const out = goalHypotheses([
      { id: "r", claim: "Weak X posts", status: "ruled_out", rank: 1, evidence: [{ at: "2026-09-27T01:00:00Z", verdict: "ruled_out", quote: "only 8% nearby", why: "too few" }] },
      { id: "t", claim: "Too few find us", status: "testing", rank: 2, research_open: true, evidence: [{ at: "2026-09-28T01:00:00Z", kind: "cgo_read", excerpt: "x" }] },
      { id: "c", claim: "Insurance ID required", status: "confirmed", rank: 3, evidence: [
        { at: "2026-09-26T01:00:00Z", verdict: "testing", quote: "", why: "unclear" },
        { at: "2026-09-28T01:00:00Z", verdict: "confirmed", quote: "33 of 47 left at the insurance step", why: "direct" },
      ] },
      { id: "l", claim: "Offer unclear", status: "listed", rank: 1, evidence: [], segment: "weekday lunch" },
      { id: "x", claim: "bad row", status: "weird", rank: 1, evidence: null },
    ]);
    expect(out.map((h) => h.id)).toEqual(["c", "t", "l", "r"]);
    expect(out.map((h) => h.segment)).toEqual([null, null, "weekday lunch", null]);
    expect(out[0].evidence[0]).toEqual({ at: "2026-09-28", verdict: "confirmed", quote: "33 of 47 left at the insurance step", why: "direct" });
    expect(out[0].evidence[1].quote).toBeNull();
    expect(out[1].evidence).toEqual([]);
    expect(out.map((h) => h.research_running)).toEqual([false, true, false, false]);
  });
});

describe("noteView splits questions from 'Left for you' lines by position", () => {
  it("keeps a 'Left for you' line that repeats a question's wording", async () => {
    const { noteView } = await import("../growth-plan");
    const v = noteView({
      saw: [], changed: [], would_change: [],
      need: ["Keep it?", "Keep it?", "Add hashed email to CAPI."],
      questions: ["Keep it?"],
      created_at: "2026-09-29T00:00:00Z", next_review_at: "2026-10-04T00:00:00Z",
    });
    expect(v.questions).toEqual(["Keep it?"]);
    expect(v.need).toEqual(["Keep it?", "Add hashed email to CAPI."]);
  });
  it("an older note with no questions key keeps need whole", async () => {
    const { noteView } = await import("../growth-plan");
    const v = noteView({ saw: [], changed: [], would_change: [], need: ["a", "b"], created_at: "x", next_review_at: "y" });
    expect(v.need).toEqual(["a", "b"]);
    expect("questions" in v).toBe(false);
  });
});

describe("noteView: a note built from items (PLAN-cgo-note-rebuild B7)", () => {
  const items = [
    { section: "needs_you", text: "Keep Reddit? Reply by Oct 3.", question_ordinal: 1 },
    { section: "needs_you", text: "Count sign-ups", reason: "$468 spent with 0 counted sign-ups", action_id: "a1", channel_slug: "google_ads" },
    { section: "changed", text: 'Goal "Get 20 signups": target 20 to 12', goal_id: "g-1", undoable: true },
    { section: "changed", text: "Paused Reddit", channel_slug: "reddit_organic", undoable: true },
    { section: "changed", text: "Rejected: Old card", action_id: "r1", channel_slug: "meta_ads" },
    { section: "blocked", text: "Create YT", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "b1", channel_slug: "youtube_ads" },
  ];
  it("passes the headline and the shared sections, with relative links and undo targets", async () => {
    const { noteView } = await import("../growth-plan");
    const v = noteView({ saw: [], changed: [], would_change: [], need: [], questions: [], created_at: "x", next_review_at: "y", items, headline: "Fix sign-up counting first." });
    expect(v.headline).toBe("Fix sign-up counting first.");
    expect(v.sections!.map((s) => s.key)).toEqual(["needs_you", "changed", "blocked"]);
    const needs = v.sections![0];
    expect(needs.rows).toEqual([
      { line: "Keep Reddit? Reply by Oct 3.", url: null, question_ordinal: 1 },
      {
        line: "Count sign-ups. $468 spent with 0 counted sign-ups.",
        url: "/workspace?tab=channels&channel=google_ads&action=a1",
        fix: { kind: "action", channel_slug: "google_ads", action_id: "a1" },
        rid: "a1",
      },
    ]);
    expect(v.sections![1].rows.map((r) => r.undo ?? null)).toEqual([{ kind: "goal", goal_id: "g-1" }, { kind: "channel", channel_slug: "reddit_organic" }, null]);
    expect(JSON.stringify(v.sections)).not.toContain('"item"');
  });
  it("the Growth page shows every Needs-you card (no N more); a derived headline when cgo gave none", async () => {
    const { noteView } = await import("../growth-plan");
    const many = Array.from({ length: 7 }, (_, i) => ({ section: "needs_you", text: `Card ${i}`, action_id: `c${i}`, channel_slug: `seo${i}` }));
    const v = noteView({ saw: [], changed: [], would_change: [], need: [], created_at: "x", next_review_at: "y", items: many, headline: null });
    expect(v.sections![0].rows).toHaveLength(7);
    expect(v.sections![0].more).toBeNull();
    expect(v.headline).toBe("7 things need you. First: Card 0.");
  });
  it("the plan line links to the plans page, labelled See plans, in Working on; never the headline", async () => {
    const { noteView } = await import("../growth-plan");
    const v = noteView({
      saw: [], changed: [], would_change: [], need: [], created_at: "x", next_review_at: "y", headline: null,
      items: [{ section: "working_on", text: "To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have", plans: true }, { section: "working_on", text: "Research: count cancelled trips" }],
    });
    expect(v.headline).toBe("Working on Research: count cancelled trips.");
    expect(v.sections).toEqual([
      expect.objectContaining({
        key: "working_on",
        rows: [
          { line: "To reach more people for this goal, Reddit and SEO would help most. Both are in the Starter plan ($20/mo); meanwhile I'm working the channels you have.", url: "/pricing", url_label: "See plans" },
          { line: "Research: count cancelled trips.", url: null },
        ],
      }),
    ]);
  });
  it("an old note has no sections", async () => {
    const { noteView } = await import("../growth-plan");
    const v = noteView({ saw: [], changed: ["x"], would_change: [], need: [], created_at: "x", next_review_at: "y", items: null });
    expect("sections" in v).toBe(false);
    expect("headline" in v).toBe(false);
  });
});

describe("head_of_growth: a note whose only content is items is shown", () => {
  it("a Blocked-only note is the latest visible note", async () => {
    settings.getBoolSettingStrictResolved.mockResolvedValueOnce(true);
    tables.autopilot_goals = [];
    tables.cgo_notes = [
      { tenant_id: "t-1", kind: "alarm", saw: [], changed: [], would_change: [], need: [], items: null, created_at: "2026-09-27T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
      { tenant_id: "t-1", kind: "alarm", saw: [], changed: [], would_change: [], need: [], questions: [], headline: "Google refused one change; nothing for you to do.", items: [{ section: "blocked", text: "Create YT", action_id: "b1", channel_slug: "youtube_ads" }], created_at: "2026-09-26T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
      { tenant_id: "t-1", kind: "scheduled", saw: ["older"], changed: ["Paused X."], would_change: [], need: [], created_at: "2026-09-25T10:00:00Z", next_review_at: "2026-10-01T00:00:00Z" },
    ];
    const body = await call();
    expect(body.head_of_growth.note?.headline).toBe("Google refused one change; nothing for you to do.");
    expect(body.head_of_growth.note?.sections?.[0]).toMatchObject({ key: "blocked", title: "Blocked on Zavi" });
  });
});

describe("currentConflicts: a mark only counts when made after the current plan", () => {
  it("drops a mark older than the plan (a failed clear on a rewrite) and everything when there is no plan", async () => {
    const { currentConflicts } = await import("../growth-plan");
    const c = [
      { goal_id: "g", hypothesis_id: "old", claim: "a", marked_at: "2026-09-01T00:00:00Z" },
      { goal_id: "g", hypothesis_id: "new", claim: "b", marked_at: "2026-09-10T00:00:00Z" },
      { goal_id: "g", hypothesis_id: "none", claim: "c", marked_at: null },
    ];
    expect(currentConflicts(c, "2026-09-05T00:00:00Z")).toEqual([{ goal_id: "g", hypothesis_id: "new", claim: "b", kept_at: null }]);
    expect(currentConflicts(c, null)).toEqual([]);
  });

  it("a keep made after the plan was written stays kept, even when the same row is re-marked later", async () => {
    const { currentConflicts } = await import("../growth-plan");
    const c = [{ goal_id: "g", hypothesis_id: "33c1d6b0", claim: "Renter demand is binding", marked_at: "2026-10-16T00:00:00Z", kept_at: "2026-10-14T17:00:00Z" }];
    expect(currentConflicts(c, "2026-10-01T00:00:00Z")).toEqual([
      { goal_id: "g", hypothesis_id: "33c1d6b0", claim: "Renter demand is binding", kept_at: "2026-10-14T17:00:00Z" },
    ]);
  });

  it("a plan rewritten after the keep voids it; a different ruled-out row is never kept", async () => {
    const { currentConflicts } = await import("../growth-plan");
    const rewritten = [{ goal_id: "g", hypothesis_id: "h", claim: "a", marked_at: "2026-10-20T00:00:00Z", kept_at: "2026-10-14T00:00:00Z" }];
    expect(currentConflicts(rewritten, "2026-10-18T00:00:00Z")[0].kept_at).toBeNull();
    const fresh = [{ goal_id: "g", hypothesis_id: "h2", claim: "a", marked_at: "2026-10-20T00:00:00Z", kept_at: null }];
    expect(currentConflicts(fresh, "2026-10-01T00:00:00Z")[0].kept_at).toBeNull();
  });
});

describe("postKeepPlanConflict: Keep my plan / Undo, on the server", () => {
  const ID = "33c1d6b0-0710-46b1-987e-9420facf8278";
  async function keep(params: Record<string, string>, body: unknown) {
    const { postKeepPlanConflict } = await import("../growth-plan");
    const res = mockRes();
    await postKeepPlanConflict({ params, body } as unknown as Request, res);
    return res;
  }
  beforeEach(() => {
    roleOk = true;
    rpcCalls.length = 0;
    rpcResult = { data: { kept_at: "2026-10-14T17:00:00Z" }, error: null };
  });

  it("keeps: calls the RPC pinned to the authed tenant with the actor, and returns kept_at", async () => {
    const res = await keep({ hypothesisId: ID }, { kept: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, kept_at: "2026-10-14T17:00:00Z" });
    expect(rpcCalls).toEqual([{ tid: "t-1", name: "set_hypothesis_plan_kept", args: { p_hypothesis_id: ID, p_actor: "u-1", p_kept: true } }]);
  });

  it("undo sends kept=false", async () => {
    rpcResult = { data: { kept_at: null }, error: null };
    const res = await keep({ hypothesisId: ID }, { kept: false });
    expect(res.body).toEqual({ ok: true, kept_at: null });
    expect(rpcCalls[0].args.p_kept).toBe(false);
  });

  it("a member (not owner/admin) is refused before any write", async () => {
    roleOk = false;
    const res = await keep({ hypothesisId: ID }, { kept: true });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it("a bad id or a missing flag is a 400 with no write", async () => {
    expect((await keep({ hypothesisId: "nope" }, { kept: true })).statusCode).toBe(400);
    expect((await keep({ hypothesisId: ID }, { kept: "yes" })).statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("no matching conflict (other tenant, not ruled out, not marked) is a 404", async () => {
    rpcResult = { data: null, error: { code: "P0002", message: "no ruled-out plan conflict" } };
    const res = await keep({ hypothesisId: ID }, { kept: true });
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("no_conflict");
  });
});

describe("needsYouFix: every blocker kind resolves to its real inline action", () => {
  const needs = (extra: Record<string, unknown>) => ({ section: "needs_you", text: "x", ...extra });
  it("maps blocker ids to actions", async () => {
    const { needsYouFix } = await import("../growth-plan");
    expect(needsYouFix(needs({ blocker_id: "connector:tiktok_ads" }) as never)).toEqual({ kind: "reconnect", slug: "tiktok_ads" });
    expect(
      needsYouFix(needs({ blocker_id: "account:meta_ads", text: "Reconnect Meta Ads and allow access to your Facebook Page" }) as never),
    ).toEqual({ kind: "reconnect", slug: "meta_ads" });
    expect(needsYouFix(needs({ blocker_id: "account:meta_ads", text: "Check your Meta Ads account status and billing" }) as never)).toBeNull();
    expect(needsYouFix(needs({ blocker_id: "ad_read_failed:b-1:tiktok:2026-10" }) as never)).toEqual({ kind: "reconnect", slug: "tiktok_ads" });
    expect(needsYouFix(needs({ blocker_id: "ad_read_failed:b-1:reddit:2026-10" }) as never)).toEqual({ kind: "reconnect", slug: "reddit_ads" });
    expect(needsYouFix(needs({ blocker_id: "ad_read_failed:b-1:chatgpt:2026-10" }) as never)).toBeNull();
    expect(needsYouFix(needs({ blocker_id: "ad_read_slow:b-1:tiktok:2026-10", text: "TikTok Ads hasn't answered for 3 hours. I'll keep trying" }) as never)).toBeNull();
    expect(needsYouFix(needs({ blocker_id: "ad_disconnected:b-1:linkedin:2026-10", text: "LinkedIn Ads was disconnected. Its $100 this month still counts toward your cap" }) as never)).toBeNull();
    expect(needsYouFix(needs({ blocker_id: "budget_brake:b-1:2026-10" }) as never)).toEqual({ kind: "budget" });
    expect(needsYouFix(needs({ blocker_id: "check:decision:d-9" }) as never)).toEqual({ kind: "check", decision_id: "d-9" });
    expect(needsYouFix(needs({ locations: true, channel_slug: "google_ads" }) as never)).toEqual({ kind: "locations", channel_slug: "google_ads" });
    expect(needsYouFix(needs({ action_id: "a1", channel_slug: "tiktok" }) as never)).toEqual({ kind: "action", channel_slug: "tiktok", action_id: "a1" });
  });
  it("question rows and non-needs sections get none", async () => {
    const { needsYouFix } = await import("../growth-plan");
    expect(needsYouFix(needs({ blocker_id: "connector:meta_ads", question_ordinal: 1 }) as never)).toBeNull();
    expect(needsYouFix({ section: "changed", text: "x", blocker_id: "connector:meta_ads" } as never)).toBeNull();
  });
});

describe("betResult (Growth J6)", () => {
  const metric = (over: Partial<GrowthPlanMetric> = {}): GrowthPlanMetric => ({
    key: "weekly_signups", label: "Weekly signups", unit: "count", direction: "up", value: 42, status: "measured",
    source: "ga4", window_end: null, denominator: null, caveat: null, ...over,
  });

  it("measured: the channel's watched metric, with where it was read", () => {
    expect(betResult("seo", [metric()], { metric_keys: ["weekly_signups"], last_run_at: null }, new Map())).toEqual({
      line: "Weekly signups: 42", label: "measured", source: "ga4",
    });
  });

  it("blocked: a Needs-you row on the channel wins over a number", () => {
    expect(betResult("seo", [metric()], { metric_keys: ["weekly_signups"], last_run_at: null }, new Map([["seo", "Connect Search Console"]])))
      .toEqual({ line: "Connect Search Console", label: "blocked", source: null });
  });

  it("unmeasured: says so, never a guess; null for a bet with no channel", () => {
    expect(betResult("seo", [metric({ status: "unavailable", value: null })], { metric_keys: ["weekly_signups"], last_run_at: "2026-10-20T03:00:00Z" }, new Map()))
      .toEqual({ line: "No number to read yet. Last worked on 2026-10-20.", label: "unmeasured", source: null });
    expect(betResult(null, [], null, new Map())).toBeNull();
  });

  it("the day a channel last worked is the founder's day, not UTC's", () => {
    const channel = { metric_keys: [], last_run_at: "2026-10-31T00:20:00Z" };
    expect(betResult("seo", [], channel, new Map(), "America/Los_Angeles")?.line).toBe("No number to read yet. Last worked on 2026-10-30.");
    expect(betResult("seo", [], channel, new Map())?.line).toBe("No number to read yet. Last worked on 2026-10-31.");
  });

  it("reads blockers from the note's Needs-you rows that name a channel", () => {
    const m = needsYouByChannel({
      autopilot: true,
      undoable: [],
      note: {
        saw: [], changed: [], would_change: [], need: [], created_at: "", next_review_at: "",
        sections: [{ key: "needs_you", title: "", more: null, rows: [{ line: "Fix the X login", url: null, fix: { kind: "action", channel_slug: "x_organic", action_id: "a" } }, { line: "Reconnect Meta", url: null, fix: { kind: "reconnect", slug: "meta_ads" } }] }],
      },
    });
    expect([...m]).toEqual([["x_organic", "Fix the X login"]]);
  });
});

