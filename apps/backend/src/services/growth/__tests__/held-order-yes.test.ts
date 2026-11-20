import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => { throw new Error("no db in this test"); } }));

const meta = vi.hoisted(() => ({ currency: "USD" as string, get: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ getAdAccountCurrency: async () => meta.currency, fbGet: (...a: unknown[]) => meta.get(...a) }));
const gads = vi.hoisted(() => ({ currency: "USD" as string }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", () => ({ readGoogleAccountCurrency: async () => gads.currency }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsGetCampaignBudget: async () => ({ amount_micros: 25_000_000 }) }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ detectCbo: (c: { daily_budget?: string | null }) => Number(c.daily_budget ?? 0) > 0 }));

import { applyHeldOrderYes, heldOrderOnYes, readLiveDailyBudget, type HeldAdOrderOnYes, type HeldOrderYesDeps } from "../held-order-yes";

const T = "tenant-a";
const Q = "11111111-1111-4111-8111-111111111111";
const SET = "120258729006520059";
const payload = { ad_set_id: SET, daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149, rationale: "Best return.", over_cap: false, name: "Rent a car at $35 per day" };
const onYes = heldOrderOnYes("meta_ads.update_ad_set_budget", payload) as HeldAdOrderOnYes;
const now = new Date("2026-10-22T16:00:00Z");

function deps(over: Partial<HeldOrderYesDeps> = {}) {
  const filed: Array<Record<string, unknown>> = [];
  const approved: Array<Record<string, unknown>> = [];
  const sent: unknown[] = [];
  let card: string | null = null;
  const d: HeldOrderYesDeps = {
    ownerId: async () => "owner-1",
    loadRole: async () => "owner",
    readLive: async () => ({ usd: 149 }),
    planLocked: async () => null,
    bodyProblem: async () => null,
    findCard: async () => card,
    file: async (a) => {
      filed.push(a);
      card = "card-1";
      return { id: "card-1", kept: false };
    },
    approve: async (a) => {
      approved.push(a);
      return { ok: true, send: approved.length === 1 ? { id: `approve:${a.action_id}:1` } : null };
    },
    send: async (e) => {
      sent.push(e);
    },
    capWarning: async () => null,
    ...over,
  };
  return { d, filed, approved, sent };
}

const apply = (d: HeldOrderYesDeps, over: Partial<Parameters<typeof applyHeldOrderYes>[0]> = {}) =>
  applyHeldOrderYes({ tenant_id: T, question: { id: Q, on_yes: onYes }, approver_user_id: null, via: "email", now, ...over }, d);

describe("heldOrderOnYes", () => {
  it("carries the exact change for a budget order whose live budget can be read", () => {
    expect(onYes).toEqual({ kind: "held_ad_order", exec_class: "meta_ads.update_ad_set_budget", payload, object_id: SET, from_usd: 149, to_usd: 178.8 });
    expect(heldOrderOnYes("google_ads.update_campaign_budget", { campaign_id: "77", daily_budget_usd: 30, expected_current_daily_budget_usd: 25 })?.object_id).toBe("77");
  });
  it("is null for an order a yes cannot re-check (a status change, a missing amount)", () => {
    expect(heldOrderOnYes("meta_ads.set_status", { object_id: SET, status: "ACTIVE" })).toBeNull();
    expect(heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: SET, daily_budget_usd: 178.8 })).toBeNull();
  });
});

describe("applyHeldOrderYes", () => {
  it("an owner's email yes files ONE card and approves it as the owner, source 'email', and sends the approval once", async () => {
    const { d, filed, approved, sent } = deps();
    const r = await apply(d);
    expect(r).toEqual({ line: 'Approved: Raise “Rent a car at $35 per day” (ad set 120258729006520059) from $149 to $178.80 a day.', refused: null, reask: false });
    expect(filed).toEqual([{ tenant_id: T, channel: "meta_ads", exec_class: "meta_ads.update_ad_set_budget", payload, question_id: Q, now }]);
    expect(approved).toEqual([{ tenant_id: T, action_id: "card-1", event_key: `held_yes:${Q}`, actor_user_id: "owner-1", source: "email" }]);
    expect(sent).toEqual([{ id: "approve:card-1:1", name: "channel-action.approved", data: { action_id: "card-1" } }]);
  });

  it("a second yes on the same question finds its card and never files a second one", async () => {
    const { d, filed, approved, sent } = deps();
    await apply(d);
    await apply(d);
    expect(filed).toHaveLength(1);
    expect(approved.map((a) => a.event_key)).toEqual([`held_yes:${Q}`, `held_yes:${Q}`]);
    expect(sent).toHaveLength(1);
  });

  it("a tap on the web or in Slack is approved as that person with no source", async () => {
    const { d, approved } = deps();
    await apply(d, { approver_user_id: "admin-2", via: "web" });
    expect(approved[0]).toMatchObject({ actor_user_id: "admin-2", source: null });
  });

  it("a budget that moved since the ask files nothing and asks again", async () => {
    const { d, filed, approved } = deps({ readLive: async () => ({ usd: 160 }) });
    const r = await apply(d);
    expect(r).toEqual({ line: null, refused: "the budget is $160.00 a day now, not the $149.00 I asked about", reask: true });
    expect(filed).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });

  it("a one-cent move is drift too", async () => {
    const { d, filed } = deps({ readLive: async () => ({ usd: 149.01 }) });
    expect((await apply(d)).reask).toBe(true);
    expect(filed).toHaveLength(0);
  });

  it("a budget that cannot be read files nothing and asks again", async () => {
    const { d, filed } = deps({ readLive: async () => null });
    expect((await apply(d)).reask).toBe(true);
    expect(filed).toHaveLength(0);
  });

  it("a budget this path can never read (non-USD, campaign-held) is not re-asked: no loop", async () => {
    const { d, filed } = deps({ readLive: async () => ({ never: "its campaign holds the budget" }) });
    expect(await apply(d)).toEqual({ line: null, refused: "I can't check this budget from here (its campaign holds the budget); change it in the ad account", reask: false });
    expect(filed).toHaveLength(0);
  });

  it("an approval whose event did not send is not recorded as applied, so a yes again re-sends it", async () => {
    const { d } = deps({ send: async () => { throw new Error("inngest down"); } });
    expect(await apply(d)).toMatchObject({ line: null, reask: false });
  });

  it("no approver id (the owner lookup failed) asks again, never uses up the question", async () => {
    const { d, filed } = deps({ ownerId: async () => null });
    expect(await apply(d)).toMatchObject({ line: null, reask: true });
    expect(filed).toHaveLength(0);
  });

  it("a retry with a card already filed: re-reads the budget; at the new amount it is done, else the same drift check", async () => {
    const done = deps({ findCard: async () => "card-1", readLive: async () => ({ usd: 178.8 }) });
    expect((await apply(done.d)).line).toMatch(/^Already done: /);
    expect(done.approved).toHaveLength(0);
    const moved = deps({ findCard: async () => "card-1", readLive: async () => ({ usd: 160 }) });
    expect(await apply(moved.d)).toMatchObject({ line: null, reask: true });
    expect(moved.approved).toHaveLength(0);
    const same = deps({ findCard: async () => "card-1" });
    expect((await apply(same.d)).line).toMatch(/^Approved: /);
    expect(same.filed).toHaveLength(0);
    expect(same.approved).toHaveLength(1);
  });

  it("a member who is not an owner or admin applies nothing", async () => {
    const { d, filed } = deps({ loadRole: async () => "member" });
    expect(await apply(d, { approver_user_id: "member-3", via: "slack" })).toMatchObject({ line: null, reask: false });
    expect(filed).toHaveLength(0);
  });

  it("a role that cannot be read, or an approval the RPC refuses, is asked again rather than used up", async () => {
    const { d, filed } = deps({ loadRole: async () => { throw new Error("db down"); } });
    expect(await apply(d)).toMatchObject({ line: null, reask: true });
    expect(filed).toHaveLength(0);
    const refused = deps({ approve: async () => ({ ok: false, code: "illegal_transition" }) });
    expect(await apply(refused.d)).toMatchObject({ line: null, reask: true });
  });

  it("an on_yes that no longer matches its payload applies nothing", async () => {
    const { d, filed } = deps();
    const r = await applyHeldOrderYes({ tenant_id: T, question: { id: Q, on_yes: { ...onYes, to_usd: 500 } }, approver_user_id: "owner-1", via: "web", now }, d);
    expect(r.line).toBeNull();
    expect(filed).toHaveLength(0);
  });

  it("a founder's own card kept by the door is never approved on this yes", async () => {
    const { d, approved } = deps({ file: async () => ({ id: "founder-card", kept: true }) });
    expect((await apply(d)).line).toBeNull();
    expect(approved).toHaveLength(0);
  });
});

describe("readLiveDailyBudget", () => {
  it("tells a budget it can read from one it never can, and from a failed read", async () => {
    meta.currency = "USD";
    meta.get.mockResolvedValueOnce({ daily_budget: "14900", campaign: { daily_budget: null } });
    expect(await readLiveDailyBudget(T, "meta_ads.update_ad_set_budget", SET)).toEqual({ usd: 149 });
    meta.get.mockResolvedValueOnce({ daily_budget: null, campaign: { daily_budget: "50000" } });
    expect(await readLiveDailyBudget(T, "meta_ads.update_ad_set_budget", SET)).toEqual({ never: "its campaign holds the budget" });
    meta.currency = "INR";
    expect(await readLiveDailyBudget(T, "meta_ads.update_ad_set_budget", SET)).toEqual({ never: "the ad account is not in US dollars" });
    meta.currency = "USD";
    meta.get.mockRejectedValueOnce(new Error("Graph 500"));
    expect(await readLiveDailyBudget(T, "meta_ads.update_ad_set_budget", SET)).toBeNull();
    expect(await readLiveDailyBudget(T, "google_ads.update_campaign_budget", "77")).toEqual({ usd: 25 });
    gads.currency = "INR";
    expect(await readLiveDailyBudget(T, "google_ads.update_campaign_budget", "77")).toEqual({ never: "the ad account is not in US dollars" });
  });
});

describe("a yes re-checks the month cap (Ravi 2026-10-29, review F1-F3)", () => {
  const WARN = "This puts you on track for $29,314 this month, $914 over your $28,400 cap";
  const REFUSED = `${WARN}. Approve it on its card to raise it anyway`;
  const raise = heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: SET, daily_budget_usd: 208.34, expected_current_daily_budget_usd: 178.8, name: "Rent a car at $35 per day" }) as HeldAdOrderOnYes;

  it("asked with no warning, month now over the cap: the card is filed but not approved, and the founder is told to approve it there", async () => {
    const { d, filed, approved, sent } = deps({ readLive: async () => ({ usd: 178.8 }), capWarning: async () => WARN });
    const r = await apply(d, { question: { id: Q, on_yes: raise } });
    expect(r).toEqual({ line: null, refused: REFUSED, reask: false });
    expect(filed).toEqual([expect.objectContaining({ payload: raise.payload, question_id: Q })]);
    expect(approved).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(raise).toMatchObject({ from_usd: 178.8, to_usd: 208.34, object_id: SET });
  });

  it("a retried yes (or a second one) on that question finds the same card: one card, never approved while it is still over the cap", async () => {
    const { d, filed, approved } = deps({ readLive: async () => ({ usd: 178.8 }), capWarning: async () => WARN });
    expect(await apply(d, { question: { id: Q, on_yes: raise } })).toEqual({ line: null, refused: REFUSED, reask: false });
    expect(await apply(d, { question: { id: Q, on_yes: raise } })).toEqual({ line: null, refused: REFUSED, reask: false });
    expect(filed).toHaveLength(1);
    expect(approved).toHaveLength(0);
  });

  it("must-not: a question asked WITH the warning applies on the first yes", async () => {
    const capWarning = vi.fn(async () => WARN);
    const { d, filed, approved } = deps({ readLive: async () => ({ usd: 178.8 }), capWarning });
    const r = await apply(d, { question: { id: Q, on_yes: { ...raise, cap_warned: true } } });
    expect(r.line).toMatch(/^Approved: /);
    expect(capWarning).not.toHaveBeenCalled();
    expect(filed).toHaveLength(1);
    expect(approved).toHaveLength(1);
  });

  it("must-not: under the cap, or an unreadable month (null), applies as before", async () => {
    const { d, filed, approved } = deps({ readLive: async () => ({ usd: 178.8 }), capWarning: async () => null });
    expect((await apply(d, { question: { id: Q, on_yes: raise } })).line).toMatch(/^Approved: /);
    expect(filed).toEqual([expect.objectContaining({ payload: raise.payload })]);
    expect(approved).toHaveLength(1);
  });

  it("must-not: a held cut is never priced and applies on the first yes", async () => {
    const cut = heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: SET, daily_budget_usd: 80, expected_current_daily_budget_usd: 100 }) as HeldAdOrderOnYes;
    const capWarning = vi.fn(async () => WARN);
    const { d, filed, approved } = deps({ readLive: async () => ({ usd: 100 }), capWarning });
    expect((await apply(d, { question: { id: Q, on_yes: cut } })).line).toMatch(/^Approved: /);
    expect(filed).toHaveLength(1);
    expect(approved).toHaveLength(1);
    expect(capWarning).not.toHaveBeenCalled();
  });
});
