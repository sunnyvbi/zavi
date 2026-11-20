import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), proxy: vi.fn(), resolve: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: mocks.exec, composioProxy: mocks.proxy }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve }));
import { endpoint, getObject, listAdAccounts, listObjects, ownedAccount, pages, proxyPages, readFailure } from "./adapter";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
const account = { tenant_id: "tenant_1", toolkit: "reddit_ads", connected_account_id: "sealed", auth_config_id: "config" } as OwnedComposioAccount;
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const byTool = (answers: Record<string, unknown>) => async ({ tool_slug }: { tool_slug: string }) => {
  const key = tool_slug.replace("REDDIT_ADS_", "");
  if (!(key in answers)) throw new Error(`unexpected ${tool_slug}`);
  return ok(answers[key]);
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.resolve.mockResolvedValue(account);
  mocks.exec.mockImplementation(byTool({ LIST_MY_BUSINESSES: [{ id: "biz" }], LIST_AD_ACCOUNTS_BY_BUSINESS: [{ id: "account_1", name: "Main", currency: "usd" }], GET_AD_ACCOUNT: { id: "account_1", currency: "USD" } }));
  mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: [] } });
});
describe("Reddit read transport", () => {
  it("passes the workspace connection and a timeout on every call", async () => {
    await listAdAccounts(account);
    expect(mocks.exec).toHaveBeenCalledWith(expect.objectContaining({ tool_slug: "REDDIT_ADS_LIST_MY_BUSINESSES", user_id: "tenant_1", connected_account_id: "sealed" }), expect.any(AbortSignal));
    expect(mocks.exec).toHaveBeenCalledWith(expect.objectContaining({ tool_slug: "REDDIT_ADS_LIST_AD_ACCOUNTS_BY_BUSINESS", arguments: { business_id: "biz" } }), expect.any(AbortSignal));
  });
  it("lists every account across businesses once, with the currency normalised", async () => {
    mocks.exec.mockImplementation(byTool({ LIST_MY_BUSINESSES: [{ id: "b1" }, { id: "b2" }], LIST_AD_ACCOUNTS_BY_BUSINESS: [{ id: "shared", name: "Shared", currency: "eur", business_id: "b1" }] }));
    expect(await listAdAccounts(account)).toEqual([{ id: "shared", name: "Shared", currency: "EUR", business_id: "b1" }]);
  });
  it("resolves the workspace connection and rejects accounts outside it before reading details", async () => {
    await expect(ownedAccount("tenant_1", "other")).rejects.toMatchObject({ code: "reddit_ads_account_not_owned" });
    expect(mocks.resolve).toHaveBeenCalledWith("tenant_1", "reddit_ads");
    expect(mocks.exec).not.toHaveBeenCalledWith(expect.objectContaining({ tool_slug: "REDDIT_ADS_GET_AD_ACCOUNT" }), expect.anything());
    mocks.resolve.mockResolvedValue(null);
    await expect(ownedAccount("tenant_1", "account_1")).rejects.toMatchObject({ code: "reddit_ads_not_connected" });
  });
  it("requires Reddit to confirm the account it was asked for", async () => {
    mocks.exec.mockImplementation(byTool({ LIST_MY_BUSINESSES: [{ id: "biz" }], LIST_AD_ACCOUNTS_BY_BUSINESS: [{ id: "account_1" }], GET_AD_ACCOUNT: { id: "account_2" } }));
    await expect(ownedAccount("tenant_1", "account_1")).rejects.toMatchObject({ code: "reddit_ads_bad_response" });
    mocks.exec.mockImplementation(byTool({ LIST_MY_BUSINESSES: [{ id: "biz" }], LIST_AD_ACCOUNTS_BY_BUSINESS: [{ id: "account_1" }], GET_AD_ACCOUNT: { id: "account_1", currency: "USD" } }));
    expect((await ownedAccount("tenant_1", "account_1")).details).toEqual({ id: "account_1", currency: "USD" });
  });
  it("rejects foreign objects, objects without an account, and broken ad relationships", async () => {
    mocks.exec.mockImplementation(byTool({ GET_AD_GROUP: { id: "g1", ad_account_id: "other", campaign_id: "c1" } }));
    await expect(getObject(account, "account_1", "ad_group", "g1")).rejects.toMatchObject({ code: "reddit_ads_object_not_owned" });
    mocks.exec.mockImplementation(byTool({ GET_AD_GROUP: { id: "g1", campaign_id: "c1" } }));
    await expect(getObject(account, "account_1", "ad_group", "g1")).rejects.toMatchObject({ code: "reddit_ads_bad_response" });
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: { id: "ad1", ad_account_id: "account_1", ad_group_id: "g1", campaign_id: "wrong" } } });
    mocks.exec.mockImplementation(byTool({ GET_AD_GROUP: { id: "g1", ad_account_id: "account_1", campaign_id: "c1" }, GET_CAMPAIGN: { id: "c1", ad_account_id: "account_1" } }));
    await expect(getObject(account, "account_1", "ad", "ad1")).rejects.toMatchObject({ code: "reddit_ads_relationship_mismatch" });
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: { id: "ad1", ad_account_id: "account_1", ad_group_id: "g1", campaign_id: "c1" } } });
    expect((await getObject(account, "account_1", "ad", "ad1")).id).toBe("ad1");
    expect(mocks.proxy).toHaveBeenLastCalledWith({ account, method: "GET", endpoint: "https://ads-api.reddit.com/api/v3/ads/ad1" }, expect.any(AbortSignal));
  });
  it("lists a level and refuses a listing that mixes in another account", async () => {
    mocks.exec.mockImplementation(byTool({ LIST_AD_GROUPS: [{ id: "g1", ad_account_id: "account_1" }, { id: "g2", ad_account_id: "account_9" }] }));
    await expect(listObjects(account, "account_1", "ad_group")).rejects.toMatchObject({ code: "reddit_ads_object_not_owned" });
    mocks.exec.mockImplementation(byTool({ LIST_AD_GROUPS: [{ id: "g1", ad_account_id: "account_1" }] }));
    expect((await listObjects(account, "account_1", "ad_group")).map((g) => g.id)).toEqual(["g1"]);
    expect(mocks.exec).toHaveBeenLastCalledWith(expect.objectContaining({ tool_slug: "REDDIT_ADS_LIST_AD_GROUPS", arguments: { ad_account_id: "account_1", page_size: 100 } }), expect.any(AbortSignal));
  });
  it("follows same-path pagination through the proxy and refuses any other page URL", async () => {
    const url = "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/ads";
    mocks.exec.mockResolvedValue({ ok: true, status: 200, data: { data: [{ id: "one" }], pagination: { next_url: `${url}?page.token=next` } } });
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: [{ id: "two" }], pagination: {} } });
    expect(await pages(account, "LIST_ADS", {}, url)).toEqual([{ id: "one" }, { id: "two" }]);
    expect(mocks.proxy).toHaveBeenCalledWith({ account, method: "GET", endpoint: `${url}?page.token=next` }, expect.any(AbortSignal));
    for (const next of ["https://evil.example/ads", "https://ads-api.reddit.com/api/v3/ad_accounts/account_2/ads", "https://user:pw@ads-api.reddit.com/api/v3/ad_accounts/account_1/ads"]) {
      mocks.exec.mockResolvedValue({ ok: true, status: 200, data: { data: [], pagination: { next_url: next } } });
      await expect(pages(account, "LIST_ADS", {}, url)).rejects.toMatchObject({ code: "reddit_ads_unsafe_pagination" });
    }
    mocks.exec.mockResolvedValue({ ok: true, status: 200, data: { data: [], pagination: { next_url: `${url}?page.token=loop` } } });
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: [], pagination: { next_url: `${url}?page.token=loop` } } });
    await expect(pages(account, "LIST_ADS", {}, url)).rejects.toMatchObject({ code: "reddit_ads_pagination_loop" });
  });
  it("fails a list whose rows are not objects instead of returning a partial result", async () => {
    mocks.exec.mockResolvedValue({ ok: true, status: 200, data: { data: [{ id: "one" }, "junk"] } });
    await expect(pages(account, "LIST_ADS", {}, "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/ads")).rejects.toMatchObject({ code: "reddit_ads_bad_response" });
  });
  it("posts report bodies through the proxy with the same pagination guard", async () => {
    const url = "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/reports";
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: { metrics: [{ spend: 1 }] } } });
    expect(await proxyPages(account, url, { fields: ["SPEND"] })).toEqual([{ spend: 1 }]);
    expect(mocks.proxy).toHaveBeenCalledWith({ account, method: "POST", endpoint: url, body: { data: { fields: ["SPEND"] } } }, expect.any(AbortSignal));
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("retries transient read failures, never a refusal, and names the refusal", async () => {
    vi.useFakeTimers();
    mocks.exec.mockResolvedValueOnce({ ok: false, status: 503, error: "down" }).mockResolvedValueOnce(ok({ id: "c1", ad_account_id: "account_1" }));
    const read = getObject(account, "account_1", "campaign", "c1");
    await vi.runAllTimersAsync();
    expect((await read).id).toBe("c1");
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    mocks.exec.mockReset().mockResolvedValue({ ok: false, status: 403, error: "forbidden" });
    await expect(getObject(account, "account_1", "campaign", "c1")).rejects.toMatchObject({ code: "reddit_ads_permission_denied" });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    mocks.proxy.mockResolvedValue({ ok: false, status: 429, json: {}, rate_limit: { "retry-after": "120" } });
    await expect(proxyPages(account, "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/reports", {})).rejects.toMatchObject({ code: "reddit_ads_rate_limited" });
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    mocks.proxy.mockReset().mockResolvedValueOnce({ ok: false, status: 429, json: {}, rate_limit: { "retry-after": "2" } }).mockResolvedValueOnce({ ok: true, status: 200, json: { data: [] } });
    const waited = proxyPages(account, "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/reports", {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waited).toEqual([]);
    expect(mocks.proxy).toHaveBeenCalledTimes(2);
  });
  it("classifies a wrapped refusal by its text and validates endpoint ids", () => {
    expect(readFailure(200, "Reddit 403 forbidden").code).toBe("reddit_ads_permission_denied");
    expect(readFailure(200, "invalid_token").code).toBe("reddit_ads_token_revoked");
    expect(readFailure(500, "boom").code).toBe("reddit_ads_request_failed");
    expect(() => endpoint("ads", "../../other")).toThrow();
  });
});
