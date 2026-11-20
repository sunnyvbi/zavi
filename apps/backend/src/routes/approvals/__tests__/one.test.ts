import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
const loadTenantRoleFor = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: (...a: unknown[]) => loadTenantRoleFor(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
const bcm = vi.hoisted(() => ({ on: false, fit: { kind: "fits" } as unknown, move: null as unknown }));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => bcm.on }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readRaiseFit: vi.fn(async () => bcm.fit) }));
const fm = vi.hoisted(() => ({ state: "available" as string | Error, calls: 0 }));
vi.mock("@/services/growth/founder-cut-candidates", () => ({
  findMoneyAvailability: vi.fn(async () => {
    fm.calls += 1;
    if (fm.state instanceof Error) throw fm.state;
    return { find_money: fm.state, find_money_why: fm.state === "none" ? "set_aside" : null };
  }),
}));
vi.mock("@/services/growth/move-card", () => ({
  moveView: vi.fn(async () => {
    if (bcm.move === "throw") throw new Error("move read failed");
    return bcm.move;
  }),
}));

type Call = { table: string; eqs: Array<[string, unknown]> };
let calls: Call[] = [];
let rows: Record<string, Record<string, unknown> | null> = {};
let readError: unknown = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("GET /api/approvals/:id must not use the service role");
  },
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const call: Call = { table, eqs: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          call.eqs.push([k, v]);
          return chain;
        },
        maybeSingle: async () => {
          if (table === "decisions" && readError) return { data: null, error: readError };
          const id = call.eqs.find(([k]) => k === "id")?.[1] as string;
          const tenant = call.eqs.find(([k]) => k === "tenant_id")?.[1];
          const r = rows[`${table}:${id}`] ?? null;
          return { data: r && r.tenant_id === tenant ? r : null, error: null };
        },
      };
      return chain;
    },
  }),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  return {
    out,
    json: (b: Record<string, unknown>) => void (out.body = b),
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
}
async function call(id: string) {
  const { approvalsOne } = await import("../one");
  const r = res();
  const next = vi.fn();
  await approvalsOne({ params: { decision_id: id } } as never, r as never, next);
  return { ...r.out, next };
}
const decision = (over: Record<string, unknown> = {}) => ({
  id: ID,
  tenant_id: TENANT,
  agent_run_id: RUN,
  decision_class: "pm.ticket",
  handler: null,
  body: {},
  status: "proposed",
  home: "needs_you",
  home_channel: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bcm.on = false;
  bcm.fit = { kind: "fits" };
  bcm.move = null;
  calls = [];
  readError = null;
  requireAuth.mockResolvedValue({ tenant_id: TENANT, access_token: "t", user_id: "u" });
  loadTenantRoleFor.mockResolvedValue("owner");
  rows = {
    [`decisions:${ID}`]: decision(),
    [`agent_runs:${RUN}`]: { id: RUN, tenant_id: TENANT, agent_slug: "pm", payload: { thread_id: "th-1" } },
  };
});

describe("GET /api/approvals/:decision_id", () => {
  it("serves the decision, its home, the approve gate and the viewer's role", async () => {
    const out = await call(ID);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      decision: { id: ID, decision_class: "pm.ticket", agent_slug: "pm", thread_id: "th-1", home: "needs_you" },
      home: { kind: "needs_you" },
      needs_owner_admin: false,
      viewer_role: "owner",
    });
    expect((out.body.decision as Record<string, unknown>).agent_run_id).toBeUndefined();
    for (const c of calls) expect(c.eqs, c.table).toContainEqual(["tenant_id", TENANT]);
  });

  it("another tenant's id is a 404, same as a missing one", async () => {
    rows[`decisions:${ID}`] = decision({ tenant_id: OTHER });
    expect((await call(ID)).status).toBe(404);
    delete rows[`decisions:${ID}`];
    const missing = await call(ID);
    expect(missing.status).toBe(404);
    expect((missing.body.error as { code: string }).code).toBe("not_found");
  });

  it("a non-UUID passes to the next route", async () => {
    const out = await call("history");
    expect(out.next).toHaveBeenCalled();
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("serves a decided row", async () => {
    rows[`decisions:${ID}`] = decision({ status: "acted" });
    expect(((await call(ID)).body.decision as { status: string }).status).toBe("acted");
  });

  it("a member on a spend-raising Meta launch is told up front", async () => {
    rows[`decisions:${ID}`] = decision({ decision_class: "meta_ads.launch_campaign", home: "growth" });
    loadTenantRoleFor.mockResolvedValue("member");
    const out = await call(ID);
    expect(out.body).toMatchObject({ needs_owner_admin: true, viewer_role: "member", home: { kind: "growth" } });
  });

  it("budget choice: switch OFF gives budget_choice and move null; ON a proposed Meta/Google raise carries both", async () => {
    rows[`decisions:${ID}`] = decision({ decision_class: "google_ads.update_campaign_budget_review", body: { campaign_id: "c1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40 } });
    expect((await call(ID)).body).toMatchObject({ budget_choice: null, move: null });
    bcm.on = true;
    bcm.fit = { kind: "over", count: { month_start: "2026-10-01", monthly_usd: 27000 }, with_usd: 27040, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    bcm.move = { key: "run-root", still_filing: false, lines: [] };
    expect((await call(ID)).body).toMatchObject({
      budget_choice: { kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, raise_to_usd: 27100 },
      move: { key: "run-root" },
    });
    rows[`decisions:${ID}`] = decision({ decision_class: "pm.ticket" });
    expect((await call(ID)).body).toMatchObject({ budget_choice: null, move: null });
  });

  it("must-catch F7: a move read that fails leaves budget_choice computed; only move is null", async () => {
    rows[`decisions:${ID}`] = decision({ decision_class: "google_ads.update_campaign_budget_review", body: { campaign_id: "c1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40 } });
    bcm.on = true;
    bcm.fit = { kind: "over", count: { month_start: "2026-10-01", monthly_usd: 27000 }, with_usd: 27040, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    bcm.move = "throw";
    expect((await call(ID)).body).toMatchObject({ budget_choice: { kind: "over", raise_to_usd: 27100 }, move: null });
  });

  it("a social post carries the draft revision its approve must echo", async () => {
    const { socialDraftVersion } = await import("@/services/approvals/social-draft-version");
    const body = { channel: "x", payload: { text: "hi" } };
    rows[`decisions:${ID}`] = decision({ decision_class: "social.publish.v2", body });
    const out = await call(ID);
    expect((out.body.decision as { post_revision?: string }).post_revision).toBe(socialDraftVersion(body));
  });

  it("serves a hold as words + evidence (never reason codes) and the founder's warnings", async () => {
    rows[`decisions:${ID}`] = decision({
      decision_class: "google_ads.update_campaign_budget_review",
      home: "growth",
      cgo_hold: { reasons: ["results_not_goal"], words: ["the conversions it counts are not the ones your goal is about"], evidence: null, at: "x" },
      founder_advice: { warnings: ["w1", "", 3], at: "x" },
    });
    const d = (await call(ID)).body.decision as Record<string, unknown>;
    expect(d.cgo_hold).toEqual({ words: ["the conversions it counts are not the ones your goal is about"], evidence: null });
    expect(d.founder_advice).toEqual({ warnings: ["w1"] });
    expect(JSON.stringify(d)).not.toContain("results_not_goal");
  });

  it("a channel home is rebuilt from the stamp", async () => {
    rows[`decisions:${ID}`] = decision({ home: "channel", home_channel: "seo" });
    expect((await call(ID)).body.home).toEqual({ kind: "channel", slug: "seo" });
  });

  it("a role read error leaves viewer_role null and still serves the card", async () => {
    loadTenantRoleFor.mockRejectedValue(new Error("down"));
    const out = await call(ID);
    expect(out.status).toBe(200);
    expect(out.body.viewer_role).toBeNull();
  });

  it("a read error is a 500, not a 404", async () => {
    readError = { message: "boom", code: "57014" };
    expect((await call(ID)).status).toBe(500);
  });
  it("find_money: on an over view whose month blocks only; available / none / a throw is unreadable; null when only the daily limit blocks", async () => {
    rows[`decisions:${ID}`] = decision({ decision_class: "google_ads.update_campaign_budget_review", body: { campaign_id: "c1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40 } });
    bcm.on = true;
    bcm.move = null;
    bcm.fit = { kind: "over", count: { month_start: "2026-10-01", monthly_usd: 27000 }, with_usd: 27040, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    fm.state = "available";
    expect((await call(ID)).body).toMatchObject({ budget_choice: { kind: "over", find_money: "available" } });
    fm.state = "none";
    expect((await call(ID)).body).toMatchObject({ budget_choice: { kind: "over", find_money: "none", find_money_why: "set_aside" } });
    fm.state = new Error("judge down");
    expect((await call(ID)).body).toMatchObject({ budget_choice: { kind: "over", find_money: "unreadable", find_money_why: null } });
    const before = fm.calls;
    bcm.fit = { kind: "over", count: { month_start: "2026-10-01", monthly_usd: 27000 }, with_usd: 26000, over_by_usd: 0, raise_to_usd: null, daily_limit_usd: 1000, daily_limit_to_usd: 1020 };
    expect((await call(ID)).body).toMatchObject({ budget_choice: { kind: "over", find_money: null, find_money_why: null } });
    expect(fm.calls).toBe(before);
  });
});

