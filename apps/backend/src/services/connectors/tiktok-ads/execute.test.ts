import { beforeEach, describe, expect, it, vi } from "vitest";

type Obj = { id: string; campaign_id: string; name: string; operation_status: string; budget: number; budget_mode: string };
const m = vi.hoisted(() => ({
  campaigns: new Map<string, Obj>(),
  adgroups: new Map<string, Obj & { adgroup_id?: string }>(),
  ads: new Map<string, Obj & { adgroup_id: string }>(),
  currency: "USD",
  posts: [] as Array<{ endpoint: string; body: Record<string, unknown> }>,
  post: "apply" as "apply" | "http400" | "code40001" | "transport" | "accept_no_change",
  readsFail: false,
  readsFailAfterPost: false,
  role: "owner" as string | null,
  hold: { status: "held", tenant_id: "T", idem_key: "k", fresh: true } as Record<string, unknown>,
  calls: [] as string[],
  verdict: { verdict: "allow", reasons: [] as string[] },
  cgoBudget: true,
  ledger: [] as Array<{ account_id: string; level: string }>,
}));

vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: async () => ({ tenant_id: "T", toolkit: "tiktok_ads", connected_account_id: "ca1", auth_config_id: "ac1" }),
}));
vi.mock("@/services/connectors/composio/api", () => ({
  composioProxy: async (a: { method: string; endpoint: string; body?: Record<string, unknown> }) => {
    const url = new URL(a.endpoint, "https://x.test");
    if (a.method === "GET") {
      if (m.readsFail || (m.readsFailAfterPost && m.posts.length > 0)) return { ok: false, status: 500, json: {} };
      const filtering = JSON.parse(url.searchParams.get("filtering") ?? "{}") as Record<string, string[]>;
      if (url.pathname === "/ad/get/") {
        const list = [...m.ads.values()].filter(a => !filtering.ad_ids || filtering.ad_ids.includes(a.id)).map(a => ({ ad_id: a.id, ad_name: a.name, campaign_id: a.campaign_id, adgroup_id: a.adgroup_id, operation_status: a.operation_status }));
        return { ok: true, status: 200, json: { code: 0, data: { list } } };
      }
      if (url.pathname === "/campaign/get/") {
        const list = [...m.campaigns.values()].filter((c) => !filtering.campaign_ids || filtering.campaign_ids.includes(c.id)).map((c) => ({ campaign_id: c.id, campaign_name: c.name, operation_status: c.operation_status, budget: c.budget, budget_mode: c.budget_mode }));
        return { ok: true, status: 200, json: { code: 0, data: { list, page_info: { total_page: 1 } } } };
      }
      if (url.pathname === "/adgroup/get/") {
        const list = [...m.adgroups.values()]
          .filter((g) => (!filtering.adgroup_ids || filtering.adgroup_ids.includes(g.id)) && (!filtering.campaign_ids || filtering.campaign_ids.includes(g.campaign_id)))
          .map((g) => ({ adgroup_id: g.id, adgroup_name: g.name, campaign_id: g.campaign_id, operation_status: g.operation_status, budget: g.budget, budget_mode: g.budget_mode }));
        return { ok: true, status: 200, json: { code: 0, data: { list, page_info: { total_page: 1 } } } };
      }
      return { ok: false, status: 404, json: {} };
    }
    m.posts.push({ endpoint: a.endpoint, body: a.body ?? {} });
    if (m.post === "http400") return { ok: false, status: 400, json: {} };
    if (m.post === "transport") return { ok: false, status: 0, json: { error: "composio_transport_error" } };
    if (m.post === "code40001") return { ok: true, status: 200, json: { code: 40001, message: "Invalid parameter" } };
    if (m.post === "apply") {
      const b = a.body ?? {};
      if (a.endpoint === "/campaign/update/") m.campaigns.get(String(b.campaign_id))!.budget = Number(b.budget);
      if (a.endpoint === "/adgroup/budget/update/") for (const x of b.budget as Array<{ adgroup_id: string; budget: number }>) m.adgroups.get(x.adgroup_id)!.budget = x.budget;
      if (a.endpoint === "/campaign/status/update/") for (const id of b.campaign_ids as string[]) m.campaigns.get(id)!.operation_status = String(b.operation_status);
      if (a.endpoint === "/adgroup/status/update/") for (const id of b.adgroup_ids as string[]) m.adgroups.get(id)!.operation_status = String(b.operation_status);
      if (a.endpoint === "/ad/status/update/") for (const id of b.ad_ids as string[]) m.ads.get(id)!.operation_status = String(b.operation_status);
    }
    return { ok: true, status: 200, json: { code: 0, data: {} } };
  },
}));
vi.mock("./ad-accounts", () => ({
  ensureAdAccounts: async () => ({ connected: true, accounts: [{ advertiser_id: "111", name: "Main", currency: m.currency, status: "ENABLE", timezone: "UTC", source: "business_center" }], selected_id: "111", needs: "nothing", checked_at: "x" }),
}));
vi.mock("@/services/decisions/ad-budget", () => ({
  reserveAdSpend: vi.fn(async (_d: unknown, a: { op: string; daily_delta_usd: number; platform: string; object_id: string }) => {
    m.calls.push(`reserve:${a.platform}:${a.op}:${a.object_id}:${a.daily_delta_usd}`);
    return m.hold;
  }),
  commitAdSpend: vi.fn(async (_h: unknown, id: string) => { m.calls.push(`commit:${id}`); }),
  dropAdSpendHold: vi.fn(async (h: { status: string }) => { m.calls.push(`drop:${h.status}`); }),
  rebaseAdSpendForObject: vi.fn(async (_t: string, p: string, id: string, n: number, _k: string, cut?: number) => { m.calls.push(`rebase:${p}:${id}:${n}:${cut}`); }),
  releaseAdSpendForObject: vi.fn(async (_t: string, p: string, id: string) => { m.calls.push(`release:${p}:${id}`); }),
}));
vi.mock("@/services/decisions/ad-changes", () => ({ recordZaviAdChange: vi.fn(async () => { m.calls.push("recorded"); }) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => m.role }));
const lock = vi.hoisted(() => ({ state: "on" as "on" | "locked" | "unreadable" }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  assertSpendWritesOn: async (_s: string, label: string, code: string) => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    if (lock.state === "unreadable") throw new ExpectedToolError(`${code}_write_disabled`, `Zavi could not confirm ${label} changes are switched on`);
    if (lock.state === "locked") throw new ExpectedToolError(`${code}_write_disabled`, `${label} changes are switched off`);
  },
}));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: async () => null }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: async () => (m.cgoBudget ? { id: "b" } : null) }));
vi.mock("@/services/growth/unattended-policy", () => ({ authorizeUnattended: async () => m.verdict }));
vi.mock("@/services/tenant-client", () => {
  const q = { select: () => q, eq: () => q, limit: async () => ({ data: m.ledger, error: null }) };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: () => q }) };
});

import { executeTiktokAction, pauseTiktokBudgetObject } from "./execute";
import { readTiktokResumePlan, resolveTiktokStatusHold, resumeDailyBudget } from "./status-budget";
import { readTiktokObject } from "./objects";
import { tiktokAdsAccount } from "./composio-read";
import { reserveAdSpend } from "@/services/decisions/ad-budget";

const base = { advertiser_id: "111", advertiser_name: "Main", rationale: "numbers", origin: "specialist" };
const campaignBudget = (from: number, to: number, st = "ACTIVE") => ({ ...base, level: "campaign", object_id: "101", campaign_id: "101", name: "Spring", expected_current_daily_budget_usd: from, expected_current_status: st, daily_budget_usd: to });
const groupBudget = (from: number, to: number, st = "ACTIVE") => ({ ...base, level: "ad_group", object_id: "201", campaign_id: "102", ad_group_id: "201", name: "Group", expected_current_daily_budget_usd: from, expected_current_status: st, daily_budget_usd: to });
const status = (level: "campaign" | "ad_group", to: "ACTIVE" | "PAUSED", daily: number | null) =>
  level === "campaign"
    ? { ...base, level, object_id: "101", campaign_id: "101", name: "Spring", status: to, expected_current_status: to === "ACTIVE" ? "PAUSED" : "ACTIVE", daily_budget_usd: daily }
    : { ...base, level, object_id: "201", campaign_id: "102", ad_group_id: "201", name: "Group", status: to, expected_current_status: to === "ACTIVE" ? "PAUSED" : "ACTIVE", daily_budget_usd: daily };
const row = (cls: string, body: unknown, over: Record<string, unknown> = {}) => ({ id: "act1", tenant_id: "T", decision_class: cls, body, approved_by: "u1", approved_by_source: null, exec_source: "channel_actions", agent_run_id: "r1", ...over });

beforeEach(() => {
  m.currency = "USD";
  m.ads = new Map([["301", { id: "301", campaign_id: "102", adgroup_id: "201", name: "Video", operation_status: "DISABLE", budget: 0, budget_mode: "" }]]);
  lock.state = "on";
  m.campaigns = new Map([
    ["101", { id: "101", campaign_id: "101", name: "Spring", operation_status: "ENABLE", budget: 60, budget_mode: "BUDGET_MODE_DAY" }],
    ["102", { id: "102", campaign_id: "102", name: "Open", operation_status: "ENABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" }],
  ]);
  m.adgroups = new Map([
    ["201", { id: "201", campaign_id: "102", name: "Group", operation_status: "ENABLE", budget: 30, budget_mode: "BUDGET_MODE_DAY" }],
    ["202", { id: "202", campaign_id: "101", name: "Child", operation_status: "ENABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" }],
  ]);
  m.posts = [];
  m.post = "apply";
  m.readsFail = false;
  m.readsFailAfterPost = false;
  m.role = "owner";
  m.hold = { status: "held", tenant_id: "T", idem_key: "k", fresh: true };
  m.calls = [];
  m.verdict = { verdict: "allow", reasons: [] };
  m.cgoBudget = true;
});

async function plannedStatus(level: "campaign" | "ad_group" | "ad", objectId: string) {
  const account = await tiktokAdsAccount("T");
  const live = (await readTiktokObject(account, "111", level, objectId))!;
  const plan = await readTiktokResumePlan(account, "111", live);
  return { ...base, level, object_id: objectId, campaign_id: live.campaign_id, ...(level !== "campaign" ? { ad_group_id: level === "ad_group" ? objectId : live.ad_group_id! } : {}), ...(level === "ad" ? { ad_id: objectId } : {}), name: live.name, status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: resumeDailyBudget(plan), resume_plan: plan };
}

describe("resuming switches whose budgets live elsewhere", () => {
  it("reserves each enabled child before an unlimited campaign resumes; leaves disabled children off", async () => {
    m.campaigns.get("102")!.operation_status = "DISABLE";
    m.adgroups.set("203", { id: "203", campaign_id: "102", name: "Second", operation_status: "ENABLE", budget: 40, budget_mode: "BUDGET_MODE_DAY" });
    m.adgroups.set("204", { id: "204", campaign_id: "102", name: "Off", operation_status: "DISABLE", budget: 50, budget_mode: "BUDGET_MODE_DAY" });
    const body = await plannedStatus("campaign", "102");
    expect(body.daily_budget_usd).toBe(70);
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ ok: true });
    expect(m.calls).toEqual(["reserve:tiktok:resume:201:30", "reserve:tiktok:resume:203:40", "recorded", "commit:201", "commit:203"]);
    expect(m.adgroups.get("204")!.operation_status).toBe("DISABLE");
    expect(m.posts).toHaveLength(1);
  });
  it("resumes an individual ad against its group budget and resolves uncertainty from the ad switch", async () => {
    const body = await plannedStatus("ad", "301");
    expect(await resolveTiktokStatusHold("T", "201", body)).toBe("not_landed");
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ ok: true });
    expect(m.calls).toEqual(["reserve:tiktok:resume:201:30", "recorded", "commit:201"]);
    expect(m.posts[0].endpoint).toBe("/ad/status/update/");
    expect(await resolveTiktokStatusHold("T", "201", body)).toBe("landed");
    expect(await resolveTiktokStatusHold("T", "999", body)).toBeNull();
  });
  it("uses the campaign budget for an ad group under CBO", async () => {
    m.adgroups.get("202")!.operation_status = "DISABLE";
    const body = await plannedStatus("ad_group", "202");
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ ok: true });
    expect(m.calls).toEqual(["reserve:tiktok:resume:101:60", "recorded", "commit:101"]);
  });
  it("rejects a changed child set or parent budget before any reserve or write", async () => {
    m.campaigns.get("102")!.operation_status = "DISABLE";
    const body = await plannedStatus("campaign", "102");
    m.adgroups.set("203", { id: "203", campaign_id: "102", name: "New", operation_status: "ENABLE", budget: 40, budget_mode: "BUDGET_MODE_DAY" });
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ code: "tiktok_ads_budget_drifted" });
    expect(m.posts).toEqual([]);
    expect(m.calls.some(c => c.startsWith("reserve"))).toBe(false);
  });
  it("keeps every child hold when the parent write outcome is unknown", async () => {
    m.campaigns.get("102")!.operation_status = "DISABLE";
    const body = await plannedStatus("campaign", "102");
    m.post = "transport";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ code: "exec_outcome_unknown" });
    expect(m.calls).toEqual(["reserve:tiktok:resume:201:30"]);
  });
  it("allows non-USD pauses and refuses non-USD budget edits and resumes", async () => {
    m.currency = "EUR";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("campaign", "PAUSED", null)))).toMatchObject({ ok: true });
    expect(await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 51, "PAUSED")))).toMatchObject({ code: "tiktok_ads_currency_unsupported" });
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("campaign", "ACTIVE", 60)))).toMatchObject({ code: "tiktok_ads_currency_unsupported" });
    expect(m.posts).toHaveLength(1);
  });
});

describe("staff kill switch (TikTok Ads channel locked)", () => {
  it("a raise is refused before any hold or write while locked, and while the lock cannot be read", async () => {
    for (const state of ["locked", "unreadable"] as const) {
      lock.state = state;
      const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
      expect(JSON.stringify(r)).toContain("tiktok_ads_write_disabled");
      expect(m.posts).toEqual([]);
    }
  });
  it("a cut still runs while locked (stopping spend always works)", async () => {
    lock.state = "locked";
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 51)));
    expect(r).toMatchObject({ ok: true });
  });
});

describe("raise", () => {
  it("reserves 125% exposure for a verified dynamic budget without changing the provider amount", async () => {
    m.adgroups.get("201")!.budget_mode = "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
    expect(await executeTiktokAction(row("tiktok_ads.update_budget", groupBudget(30, 40)))).toMatchObject({ ok: true });
    expect(reserveAdSpend).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ daily_delta_usd: 10, delivery_factor: 1.25 }));
    expect(m.posts[0].body.budget).toEqual([{ adgroup_id: "201", budget: 40 }]);
  });
  it("a campaign raise takes a 1x hold for what it adds, writes, reads back, commits", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toEqual({ ok: true, notice: expect.any(String) });
    expect(m.calls).toEqual(["reserve:tiktok:raise:101:20", "recorded", "commit:101"]);
    expect(m.posts).toEqual([{ endpoint: "/campaign/update/", body: { advertiser_id: "111", campaign_id: "101", budget: 80 } }]);
  });
  it("an ad group raise goes to the ad-group budget endpoint and holds on the ad group", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", groupBudget(30, 40)));
    expect(r.ok).toBe(true);
    expect(m.calls[0]).toBe("reserve:tiktok:raise:201:10");
    expect(m.posts[0]).toEqual({ endpoint: "/adgroup/budget/update/", body: { advertiser_id: "111", budget: [{ adgroup_id: "201", budget: 40 }] } });
  });
  it("over the monthly cap: refused, nothing written", async () => {
    m.hold = { status: "refused", error: "ad_budget_refused: over this month's budget" };
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_budget_refused" });
    expect(m.posts).toEqual([]);
    expect(m.campaigns.get("101")!.budget).toBe(60);
  });
  it("a member cannot approve a raise (re-checked in the executor); nothing reserved or written", async () => {
    m.role = "member";
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_admin_required", held_for_founder: true });
    expect(m.calls.filter((c) => c.startsWith("reserve"))).toEqual([]);
    expect(m.posts).toEqual([]);
  });
  it("a role that cannot be read refuses (fail closed)", async () => {
    m.role = null;
    expect(await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)))).toMatchObject({ ok: false, code: "tiktok_ads_admin_required" });
  });
  it("drift: the live budget is not the card's expected one -> refused, no hold, no write", async () => {
    m.campaigns.get("101")!.budget = 70;
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_budget_drifted" });
    expect(m.calls.filter((c) => c.startsWith("reserve"))).toEqual([]);
    expect(m.posts).toEqual([]);
  });
  it("status drift: switched on/off in TikTok since the card was proposed -> refused, no hold, no write", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80, "PAUSED")));
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain("tiktok_ads_status_drifted");
    expect(m.posts).toEqual([]);
  });
  it("a lifetime-budget object is never changed", async () => {
    m.campaigns.get("101")!.budget_mode = "BUDGET_MODE_TOTAL";
    expect(await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)))).toMatchObject({ ok: false, code: "tiktok_ads_budget_mode_unsupported" });
    expect(m.posts).toEqual([]);
  });
  it("read-back does not show the new budget: outcome_unknown, the hold is KEPT", async () => {
    m.post = "accept_no_change";
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(m.calls).toEqual(["reserve:tiktok:raise:101:20"]);
  });
  it("read-back fails after the write: outcome_unknown, the hold is KEPT", async () => {
    m.readsFailAfterPost = true;
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
    expect(m.calls.some((c) => c.startsWith("drop"))).toBe(false);
  });
  it("a lost write response (transport): outcome_unknown, the hold is KEPT", async () => {
    m.post = "transport";
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
    expect(m.calls.some((c) => c.startsWith("drop"))).toBe(false);
  });
  it.each(["http400", "code40001"] as const)("TikTok definitely refused (%s): the hold is released", async (mode) => {
    m.post = mode;
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_write_refused" });
    expect(r.outcome_unknown).toBeUndefined();
    expect(m.calls).toEqual(["reserve:tiktok:raise:101:20", "drop:held"]);
  });
  it("a Composio read failure before the write: refused, nothing written, any hold released", async () => {
    m.readsFail = true;
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 80)));
    expect(r.ok).toBe(false);
    expect(r.outcome_unknown).toBeUndefined();
    expect(m.posts).toEqual([]);
    expect(m.calls).toEqual(["drop:no_budget"]);
  });
});

describe("cut and pause always pass the budget", () => {
  it("a cut reserves nothing, any member may approve it, and the hold is rebased by the cut", async () => {
    m.role = "member";
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 51)));
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual(["recorded", "rebase:tiktok:101:51:9"]);
  });
  it("a campaign pause reserves nothing and releases the campaign's and its ad groups' holds", async () => {
    m.role = "member";
    m.hold = { status: "refused", error: "over" };
    const r = await executeTiktokAction(row("tiktok_ads.set_status", status("campaign", "PAUSED", null)));
    expect(r.ok).toBe(true);
    expect(m.posts[0]).toEqual({ endpoint: "/campaign/status/update/", body: { advertiser_id: "111", campaign_ids: ["101"], operation_status: "DISABLE" } });
    expect(m.calls).toEqual(["recorded", "release:tiktok:101", "release:tiktok:202"]);
  });
  it("an ad group pause releases only that ad group", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "PAUSED", null)));
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual(["recorded", "release:tiktok:201"]);
  });
  it("drift: already paused by someone else -> refused, nothing written", async () => {
    m.campaigns.get("101")!.operation_status = "DISABLE";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("campaign", "PAUSED", null)))).toMatchObject({ ok: false, code: "tiktok_ads_status_drifted" });
    expect(m.posts).toEqual([]);
  });
});

describe("resume", () => {
  beforeEach(() => { m.adgroups.get("201")!.operation_status = "DISABLE"; });
  it("holds the object's whole daily budget (1x), owner-approved", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "ACTIVE", 30)));
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual(["reserve:tiktok:resume:201:30", "recorded", "commit:201"]);
    expect(m.posts[0].body).toEqual({ advertiser_id: "111", adgroup_ids: ["201"], operation_status: "ENABLE" });
  });
  it("a member cannot approve a resume", async () => {
    m.role = "member";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "ACTIVE", 30)))).toMatchObject({ ok: false, code: "tiktok_ads_admin_required" });
    expect(m.posts).toEqual([]);
  });
  it("the budget changed since the card: refused, no hold", async () => {
    m.adgroups.get("201")!.budget = 45;
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "ACTIVE", 30)))).toMatchObject({ ok: false, code: "tiktok_ads_budget_drifted" });
    expect(m.calls.some((c) => c.startsWith("reserve"))).toBe(false);
  });
  it("staff never approves; no approver never runs", async () => {
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "ACTIVE", 30), { approved_by_source: "staff" }))).toMatchObject({ ok: false, code: "tiktok_ads_approval_required" });
    expect(await executeTiktokAction(row("tiktok_ads.set_status", status("ad_group", "ACTIVE", 30), { approved_by: null }))).toMatchObject({ ok: false, code: "tiktok_ads_approval_required" });
    expect(m.posts).toEqual([]);
  });
});

describe("Autopilot (cgo) approvals", () => {
  const cgo = { approved_by: null, approved_by_source: "cgo" };
  it("allowed by the unattended gate with a budget hold: written", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 72), cgo));
    expect(r.ok).toBe(true);
  });
  it("held by the gate: nothing reserved or written, back to the founder", async () => {
    m.verdict = { verdict: "ask_founder", reasons: ["raise_over_cgo_step"] };
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 200), cgo));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_policy_held", held_for_founder: true });
    expect(m.posts).toEqual([]);
  });
  it("no active ad budget: cgo cannot write without a hold", async () => {
    m.hold = { status: "no_budget" };
    const r = await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 72), cgo));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_budget_required" });
    expect(m.posts).toEqual([]);
  });
  it("Autopilot switched off: held", async () => {
    m.cgoBudget = false;
    expect(await executeTiktokAction(row("tiktok_ads.update_budget", campaignBudget(60, 72), cgo))).toMatchObject({ ok: false, code: "tiktok_ads_autopilot_off" });
  });
});

it("an advertiser that is no longer saved is refused before any read", async () => {
  const r = await executeTiktokAction(row("tiktok_ads.update_budget", { ...campaignBudget(60, 80), advertiser_id: "999" }));
  expect(r).toMatchObject({ ok: false, code: "tiktok_ads_unknown_account" });
  expect(m.posts).toEqual([]);
});

describe("the founder's Stop pauses a held TikTok object", () => {
  it("pauses it on the ad account and level the ledger names, and confirms it", async () => {
    m.ledger = [{ account_id: "111", level: "ad_group" }];
    await pauseTiktokBudgetObject("T", "201");
    expect(m.posts).toEqual([{ endpoint: "/adgroup/status/update/", body: { advertiser_id: "111", adgroup_ids: ["201"], operation_status: "DISABLE" } }]);
  });
  it("an unconfirmed pause throws (the hold stays); an object on none of the saved accounts throws before any write", async () => {
    m.ledger = [{ account_id: "111", level: "campaign" }];
    m.post = "accept_no_change";
    await expect(pauseTiktokBudgetObject("T", "101")).rejects.toThrow("did not confirm");
    m.posts = [];
    m.ledger = [];
    await expect(pauseTiktokBudgetObject("T", "999")).rejects.toThrow("Cannot tell");
    expect(m.posts).toEqual([]);
  });
});
