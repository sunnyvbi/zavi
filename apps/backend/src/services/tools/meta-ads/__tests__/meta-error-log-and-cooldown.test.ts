
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: async (_t: string, key: string) => (key === "meta_ads.access_token" ? "SECRET-TOKEN-abc" : "act_999"),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: async () => undefined } }));
const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (row: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r, 5));
    logged.push(row);
  },
}));

import { fbGet, fbPost, _resetMetaUsage } from "../_client";
import { _memoryCooldownStore, _setMetaCooldownStoreForTest, withMetaCaller, withMetaDecisionExec, MetaCoolingDownError } from "../_cooldown";
import { metaSetStatus } from "../write/set_status";
import { customAudienceTermsAccepted, assertCustomAudienceTermsAccepted } from "../write/launch";
import { checkUpdatedAdSetBid } from "../write/adset_ad_writes";
import { classifyExecFailure } from "@/services/channels/exec-failure";

const T = "11111111-1111-1111-1111-111111111111";
const RATE_LIMIT = JSON.stringify({ error: { message: "User request limit reached", type: "OAuthException", code: 17, error_subcode: 2446079 } });

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

let store: ReturnType<typeof _memoryCooldownStore>;
let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

beforeEach(() => {
  logged.length = 0;
  _resetMetaUsage();
  store = _memoryCooldownStore();
  _setMetaCooldownStoreForTest(store);
  fetchSpy = vi.spyOn(global, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
  _setMetaCooldownStoreForTest(null);
});

describe("Meta error log", () => {
  it("writes one warn row per error response with caller, code, subcode and ad account, and never the token", async () => {
    fetchSpy.mockResolvedValueOnce(
      res(400, { error: { message: "Invalid parameter access_token=SECRET-TOKEN-abc https://graph.facebook.com/v25.0/x?access_token=SECRET-TOKEN-abc", code: 100, error_subcode: 2490487 } }),
    );
    await expect(withMetaCaller("tool:create_ad_set", () => fbPost(T, "act_999/adsets", { name: "x" }))).rejects.toMatchObject({ code: "meta_ads_write_failed" });
    expect(logged).toHaveLength(1);
    const row = logged[0]!;
    expect(row).toMatchObject({ level: "warn", source: "meta-ads", code: "meta_api_error", tenant_id: T });
    expect(row.meta).toEqual({ caller: "tool:create_ad_set", graph_code: 100, subcode: 2490487, ad_account: "act_999", http_status: 400 });
    expect(JSON.stringify(row)).not.toContain("SECRET-TOKEN-abc");
  });

  it("the row is written before the Graph error is thrown (an Inngest step ending on it keeps the row)", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    const e = await fbGet(T, "act_999/insights", {}).catch((x) => x);
    expect(e).toMatchObject({ code: "meta_ads_query_failed" });
    expect(logged).toHaveLength(1);
  });

  it("labels an unlabelled call 'unknown', and an explicit caller wins", async () => {
    fetchSpy.mockResolvedValueOnce(res(500, "<html>bad gateway</html>")).mockResolvedValueOnce(res(500, "oops"));
    await expect(fbGet(T, "act_999/campaigns", {})).rejects.toThrow();
    await expect(withMetaCaller("dashboard", () => fbGet(T, "act_999/campaigns", {}, { caller: "cgo_evidence" }))).rejects.toThrow();
    expect(logged.map((r) => (r.meta as { caller: string }).caller)).toEqual(["unknown", "cgo_evidence"]);
  });

  it("logs usage at 90%+ once per crossing", async () => {
    const hi = { "x-ad-account-usage": '{"acc_id_util_pct":93}' };
    fetchSpy
      .mockResolvedValueOnce(res(200, {}, hi))
      .mockResolvedValueOnce(res(200, {}, hi))
      .mockResolvedValueOnce(res(200, {}, { "x-ad-account-usage": '{"acc_id_util_pct":20}' }))
      .mockResolvedValueOnce(res(200, {}, hi));
    for (let i = 0; i < 4; i++) await fbGet(T, "act_999", {});
    expect(logged.filter((r) => r.code === "meta_usage_high")).toHaveLength(2);
  });
});

describe("rate-limit cooldown", () => {
  it("code 17 starts a cooldown for the ad account (Meta's regain time, else 5 min)", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    const before = Date.now();
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    const row = store.rows.get("act_999");
    expect(row?.probe_claimed).toBe(false);
    expect(row!.until - before).toBeGreaterThanOrEqual(5 * 60_000 - 50);
    expect(row!.until - before).toBeLessThan(5 * 60_000 + 5_000);
  });

  it("an optional reader (cgo evidence) sends nothing and gets MetaCoolingDownError", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    fetchSpy.mockClear();
    const e = await withMetaCaller("cgo_evidence", () => fbGet(T, "act_999/adsets", {})).catch((x) => x);
    expect(e).toBeInstanceOf(MetaCoolingDownError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an agent tool gets meta_ads_busy with how long to wait", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    await expect(withMetaCaller("tool:list_campaigns", () => fbGet(T, "act_999/campaigns", {}))).rejects.toMatchObject({
      code: "meta_ads_busy",
      message: expect.stringMatching(/^Meta is busy for [1-5] min; try again after \d\d:\d\d UTC$/),
    });
  });

  it("the reconcile gets exactly one probe; a successful probe ends the cooldown for everyone", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    fetchSpy.mockResolvedValueOnce(res(200, { id: "act_999" })).mockResolvedValueOnce(res(200, { data: [] }));
    await expect(withMetaCaller("reconcile", () => fbGet(T, "act_999", {}))).resolves.toEqual({ id: "act_999" });
    expect(store.rows.has("act_999")).toBe(false);
    await expect(withMetaCaller("tool:list_campaigns", () => fbGet(T, "act_999/campaigns", {}))).resolves.toEqual({ data: [] });
  });

  it("a failed probe keeps the cooldown and uses up the window: the next reconcile call sends nothing", async () => {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    fetchSpy.mockResolvedValueOnce(res(500, "upstream"));
    await expect(withMetaCaller("reconcile", () => fbGet(T, "act_999", {}))).rejects.toMatchObject({ code: "meta_ads_query_failed" });
    fetchSpy.mockClear();
    await expect(withMetaCaller("reconcile", () => fbGet(T, "act_999", {}))).rejects.toMatchObject({ code: "meta_ads_busy" });
    await expect(withMetaCaller("spend_controller", () => fbGet(T, "act_999", {}))).rejects.toMatchObject({ code: "meta_ads_busy" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.rows.get("act_999")?.probe_claimed).toBe(true);
  });

  async function coolDown() {
    fetchSpy.mockResolvedValueOnce(res(400, RATE_LIMIT));
    await expect(fbGet(T, "act_999/insights", {})).rejects.toThrow();
    fetchSpy.mockClear();
  }

  it("an approved pause runs during the cooldown, its drift read included", async () => {
    await coolDown();
    fetchSpy.mockResolvedValueOnce(res(200, { status: "ACTIVE" })).mockResolvedValueOnce(res(200, { success: true }));
    const out = await withMetaDecisionExec("meta_ads.set_status_review", { object_id: "1", status: "PAUSED" }, async () => {
      await fbGet(T, "1", { fields: "status" });
      return metaSetStatus(T, { object_id: "1", level: "adset", status: "PAUSED" });
    });
    expect(out.status).toBe("PAUSED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an approved budget cut runs during the cooldown; an approved raise is refused with meta_ads_busy and sends nothing", async () => {
    await coolDown();
    fetchSpy.mockResolvedValueOnce(res(200, { daily_budget: "5000" })).mockResolvedValueOnce(res(200, { success: true }));
    await withMetaDecisionExec("meta_ads.update_ad_set_budget", { daily_budget_usd: 40, expected_current_daily_budget_usd: 50 }, async () => {
      await fbGet(T, "1", { fields: "daily_budget" });
      await fbPost(T, "1", { daily_budget: "4000" });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockClear();
    await expect(
      withMetaDecisionExec("meta_ads.update_ad_set_budget", { daily_budget_usd: 60, expected_current_daily_budget_usd: 50 }, () => fbGet(T, "1", { fields: "daily_budget" })),
    ).rejects.toMatchObject({ code: "meta_ads_busy" });
    await expect(withMetaDecisionExec("meta_ads.set_status", { status: "ACTIVE" }, () => metaSetStatus(T, { object_id: "1", level: "adset", status: "ACTIVE" }))).rejects.toMatchObject({ code: "meta_ads_busy" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pause from any caller (a rollback, the rights-expiry job) is never held", async () => {
    await coolDown();
    fetchSpy.mockResolvedValueOnce(res(200, { success: true }));
    await expect(metaSetStatus(T, { object_id: "1", level: "ad", status: "PAUSED" })).resolves.toMatchObject({ status: "PAUSED" });
  });

  it("a store outage never blocks a call (fail-open)", async () => {
    _setMetaCooldownStoreForTest({
      read: async () => {
        throw new Error("db down");
      },
      start: async () => {
        throw new Error("db down");
      },
      claimProbe: async () => {
        throw new Error("db down");
      },
      clear: async () => {
        throw new Error("db down");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValueOnce(res(200, { ok: 1 }));
    await expect(fbGet(T, "act_999", {})).resolves.toEqual({ ok: 1 });
  });
});

describe("known-bad writes are refused before Meta", () => {
  it("custom audience terms: accepted only when tos_accepted.custom_audience_tos is 1", () => {
    expect(customAudienceTermsAccepted({ custom_audience_tos: 1 })).toBe(true);
    expect(customAudienceTermsAccepted({ web_custom_audience_tos: 1 })).toBe(false);
    expect(customAudienceTermsAccepted(undefined)).toBe(false);
  });

  it("an account without the terms gets a founder-facing refusal sorted needs_founder; a failed read lets Meta decide", async () => {
    fetchSpy.mockResolvedValueOnce(res(200, { id: "act_999" }));
    const e = await assertCustomAudienceTermsAccepted(T, "act_999").catch((x) => x);
    expect(e).toMatchObject({ code: "meta_ads_custom_audience_terms" });
    expect(e.message).toContain("https://www.facebook.com/customaudiences/app/tos/?act=999");
    expect(classifyExecFailure({ code: e.code, error: e.message })).toMatchObject({ bucket: "needs_founder", fix: "audience_terms" });
    fetchSpy.mockResolvedValueOnce(res(200, { tos_accepted: { custom_audience_tos: 1 } }));
    await expect(assertCustomAudienceTermsAccepted(T, "act_999")).resolves.toBeUndefined();
    fetchSpy.mockResolvedValueOnce(res(500, "down"));
    await expect(assertCustomAudienceTermsAccepted(T, "act_999")).resolves.toBeUndefined();
  });

  it("an ad set update that would leave a bid cap or cost cap without an amount is refused (Meta 100/2490487)", () => {
    const base = { campaign_budget: false, live_strategy: "LOWEST_COST_WITHOUT_CAP", live_has_amount: false };
    expect(checkUpdatedAdSetBid({ ...base, bid_strategy: "COST_CAP" })).toMatch(/no bid amount/);
    expect(checkUpdatedAdSetBid({ ...base, bid_strategy: "COST_CAP", bid_amount_usd: 12 })).toBeNull();
    expect(checkUpdatedAdSetBid({ ...base, live_strategy: "LOWEST_COST_WITH_BID_CAP", live_has_amount: true, bid_amount_usd: 9 })).toBeNull();
    expect(checkUpdatedAdSetBid({ ...base, bid_strategy: "LOWEST_COST_WITH_MIN_ROAS" })).toMatch(/ROAS floor/);
    expect(checkUpdatedAdSetBid({ ...base, campaign_budget: true, bid_strategy: "COST_CAP" })).toBeNull();
  });
});
