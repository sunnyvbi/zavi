import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedComposioAccount } from "../composio/api";

const m = vi.hoisted(() => ({ proxy: vi.fn(), row: null as Record<string, unknown> | null, rpc: vi.fn(), ca: "ca_1" }));
vi.mock("../composio/api", () => ({ composioProxy: m.proxy }));
vi.mock("../composio/account", () => ({
  resolveOwnedComposioAccount: async () => ({ tenant_id: "t", toolkit: "tiktok_ads", connected_account_id: m.ca, auth_config_id: "ac" }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }) }) }),
  }),
  tenantRpc: (_t: string, name: string, args: Record<string, unknown>) => m.rpc(name, args),
}));

import { addManualAdAccount, ensureAdAccounts, readCurrentAdAccounts, parseAdvertiserInput, selectAdAccount, syncAdAccounts } from "./ad-accounts";

const account = { tenant_id: "t", toolkit: "tiktok_ads", connected_account_id: "ca_1", auth_config_id: "ac" } as OwnedComposioAccount;
let bcAdvertisers: string[];
let reachable: Set<string>;

const ok = (list: unknown[], page_info?: unknown) => ({ ok: true, status: 200, json: { code: 0, data: { list, ...(page_info ? { page_info } : {}) } } });

beforeEach(() => {
  bcAdvertisers = ["111"];
  reachable = new Set(["111", "222", "333"]);
  m.row = null;
  m.ca = "ca_1";
  m.rpc.mockReset();
  m.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    if ((m.row?.ad_accounts_checked_at ?? null) !== (args.p_prev_checked_at ?? null)) return { data: null, error: null };
    const at = `v${m.rpc.mock.calls.length}`;
    m.row = { team_id: "ca_1", ad_accounts: args.p_accounts, selected_ad_account_id: args.p_selected, ad_accounts_for: args.p_for, ad_accounts_checked_at: at };
    return { data: at, error: null };
  });
  m.proxy.mockReset();
  m.proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
    const url = new URL(endpoint, "https://x.test");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname === "/bc/get/") return ok([{ bc_info: { bc_id: `bc${page}` } }], { total_page: 2 });
    if (url.pathname === "/bc/asset/get/") {
      return url.searchParams.get("bc_id") === "bc1" ? ok(bcAdvertisers.map((asset_id) => ({ asset_id }))) : ok([]);
    }
    if (url.pathname === "/advertiser/info/") {
      const ids = JSON.parse(url.searchParams.get("advertiser_ids") ?? "[]") as string[];
      const fields = JSON.parse(url.searchParams.get("fields") ?? "[]") as string[];
      const pick = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k)));
      return ok(ids.filter((id) => reachable.has(id)).map((id) => pick({ advertiser_id: id, name: `Acct ${id}`, currency: "USD", status: "STATUS_ENABLE" })));
    }
    return ok([]);
  });
});

describe("parseAdvertiserInput", () => {
  it.each([
    ["7683915592165785621", "7683915592165785621"],
    [" 7683915592165785621 ", "7683915592165785621"],
    ["https://ads.tiktok.com/i18n/perf/campaign?aadvid=7683915592165785621&foo=1", "7683915592165785621"],
    ["https://ads.tiktok.com/i18n/dashboard?aadvid=7683915592165785621", "7683915592165785621"],
  ])("reads %s", (input, id) => expect(parseAdvertiserInput(input)).toBe(id));

  it.each(["", "abc", "123", "https://ads.tiktok.com/i18n/dashboard", "aadvid=12x45678"])("rejects %s", (input) => {
    expect(parseAdvertiserInput(input)).toBeNull();
  });
});

describe("current account display", () => {
  it("refreshes stale status without rewriting the selection or its revision", async () => {
    m.row = { team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "old-revision", selected_ad_account_id: "111", ad_accounts: [{ advertiser_id: "111", name: "Old", status: "SELF_SERVICE_UNAUDITED", source: "manual" }] };
    expect(await readCurrentAdAccounts("t")).toMatchObject({ selected_id: "111", checked_at: "old-revision", accounts: [{ advertiser_id: "111", status: "ENABLE", source: "manual" }] });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.proxy).toHaveBeenCalledTimes(1);
  });
  it("does not show inaccessible saved accounts as connected and selected", async () => {
    m.row = { team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "old", selected_ad_account_id: "111", ad_accounts: [{ advertiser_id: "111", source: "manual" }] };
    reachable.clear();
    expect(await readCurrentAdAccounts("t")).toMatchObject({ selected_id: null, accounts: [], needs: "paste" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("surfaces a provider failure instead of displaying cached account health", async () => {
    m.row = { team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "old", selected_ad_account_id: "111", ad_accounts: [{ advertiser_id: "111", source: "manual" }] };
    m.proxy.mockResolvedValue({ ok: false, status: 503 });
    await expect(readCurrentAdAccounts("t")).rejects.toMatchObject({ code: "tiktok_ads_read_failed" });
  });
});

describe("syncAdAccounts", () => {
  it("reads every Business Center page and auto-selects a lone account", async () => {
    const s = await syncAdAccounts(account);
    expect(m.proxy.mock.calls.some(([a]) => String(a.endpoint).includes("/bc/get/?page=2"))).toBe(true);
    expect(s).toMatchObject({ needs: "nothing", selected_id: "111" });
    expect(s.accounts).toEqual([expect.objectContaining({ advertiser_id: "111", name: "Acct 111", status: "ENABLE", source: "business_center" })]);
  });

  it("asks the founder to pick when several are found", async () => {
    bcAdvertisers = ["111", "222"];
    expect(await syncAdAccounts(account)).toMatchObject({ needs: "pick", selected_id: null });
  });

  it("drops a discovered id TikTok does not confirm, and asks for a paste when none remain", async () => {
    reachable = new Set();
    expect(await syncAdAccounts(account)).toMatchObject({ needs: "paste", accounts: [], selected_id: null });
  });

  it("keeps a pasted account and the earlier choice on the same login", async () => {
    bcAdvertisers = ["111", "222"];
    m.row = {
      team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "x", selected_ad_account_id: "333",
      ad_accounts: [{ advertiser_id: "333", name: "Pasted", source: "manual" }],
    };
    const s = await syncAdAccounts(account);
    expect(s.selected_id).toBe("333");
    expect(s.accounts.map((a) => [a.advertiser_id, a.source])).toEqual([["111", "business_center"], ["222", "business_center"], ["333", "manual"]]);
  });

  it("forgets accounts saved for a different login", async () => {
    m.row = { team_id: "ca_1", ad_accounts_for: "ca_old", ad_accounts_checked_at: "x", selected_ad_account_id: "333", ad_accounts: [{ advertiser_id: "333", source: "manual" }] };
    const s = await syncAdAccounts(account);
    expect(s.accounts.map((a) => a.advertiser_id)).toEqual(["111"]);
  });

  it("falls back to the paste box when Business Center discovery fails", async () => {
    m.proxy.mockImplementationOnce(async () => ({ ok: true, status: 200, json: { code: 40001, message: "no permission" } }));
    expect(await syncAdAccounts(account)).toMatchObject({ needs: "paste" });
  });

  it("reports a reconnect that landed mid-save instead of claiming success", async () => {
    m.rpc.mockImplementationOnce(async () => {
      m.row = { team_id: "ca_2", ad_accounts_for: "ca_2", ad_accounts_checked_at: "other", selected_ad_account_id: null, ad_accounts: [] };
      return { data: null, error: null };
    });
    await expect(syncAdAccounts(account)).rejects.toMatchObject({ code: "tiktok_ads_reconnected" });
  });

  it("never overwrites a pick the founder made while discovery was running", async () => {
    bcAdvertisers = ["111", "222"];
    m.row = {
      team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "v0", selected_ad_account_id: null,
      ad_accounts: [{ advertiser_id: "111", source: "business_center" }, { advertiser_id: "222", source: "business_center" }],
    };
    const proxy = m.proxy.getMockImplementation()!;
    m.proxy.mockImplementation(async (a: { endpoint: string }) => {
      if (String(a.endpoint).startsWith("/advertiser/info/") && m.row?.ad_accounts_checked_at === "v0") {
        m.row = { ...m.row, selected_ad_account_id: "222", ad_accounts_checked_at: "founder" };
      }
      return proxy(a);
    });
    const s = await syncAdAccounts(account);
    expect(s.selected_id).toBe("222");
    expect(m.row?.selected_ad_account_id).toBe("222");
  });

  it("keeps the accounts it found before when TikTok fails mid-search", async () => {
    m.row = {
      team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "v0", selected_ad_account_id: "111",
      ad_accounts: [{ advertiser_id: "111", name: "Acct 111", source: "business_center" }],
    };
    const proxy = m.proxy.getMockImplementation()!;
    m.proxy.mockImplementation(async (a: { endpoint: string }) =>
      String(a.endpoint).startsWith("/bc/get/") ? { ok: true, status: 200, json: { code: 40100, message: "rate limited" } } : proxy(a));
    expect(await syncAdAccounts(account)).toMatchObject({ selected_id: "111", needs: "nothing" });
  });
});

describe("ensureAdAccounts", () => {
  it("serves a current list from the row without calling TikTok", async () => {
    m.row = { team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "x", selected_ad_account_id: "111", ad_accounts: [{ advertiser_id: "111", name: "A" }] };
    expect(await ensureAdAccounts("t")).toMatchObject({ connected: true, selected_id: "111", needs: "nothing" });
    expect(m.proxy).not.toHaveBeenCalled();
  });

  it("is not connected without a row", async () => {
    expect(await ensureAdAccounts("t")).toMatchObject({ connected: false });
  });
});

describe("manual entry and selection", () => {
  beforeEach(() => {
    reachable = new Set(["111", "2220000"]);
    m.row = {
      team_id: "ca_1", ad_accounts_for: "ca_1", ad_accounts_checked_at: "x", selected_ad_account_id: null,
      ad_accounts: [{ advertiser_id: "111", name: "Acct 111", source: "business_center" }],
    };
  });

  it("saves and selects a pasted Ads Manager link TikTok confirms for this token", async () => {
    const s = await addManualAdAccount("t", "https://ads.tiktok.com/i18n/perf/campaign?aadvid=2220000&x=1");
    expect(s).toMatchObject({ selected_id: "2220000", needs: "nothing" });
    expect(s.accounts.map((a) => [a.advertiser_id, a.source])).toEqual([["111", "business_center"], ["2220000", "manual"]]);
  });

  it("refuses an ID TikTok does not confirm and saves nothing", async () => {
    await expect(addManualAdAccount("t", "9990000")).rejects.toMatchObject({ code: "tiktok_ads_account_not_reachable" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a pasted ID when TikTok Ads is reconnected after it was verified", async () => {
    const proxy = m.proxy.getMockImplementation()!;
    m.proxy.mockImplementation(async (req: { endpoint: string }) => {
      const res = await proxy(req);
      if (new URL(req.endpoint, "https://x.test").pathname === "/advertiser/info/") m.ca = "ca_2";
      return res;
    });
    await expect(addManualAdAccount("t", "2220000")).rejects.toMatchObject({ code: "tiktok_ads_reconnected" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses text that holds no ID before calling TikTok", async () => {
    await expect(addManualAdAccount("t", "my account")).rejects.toMatchObject({ code: "tiktok_ads_bad_account_id" });
    expect(m.proxy).not.toHaveBeenCalled();
  });

  it("selects only an account already in the saved list", async () => {
    expect(await selectAdAccount("t", "111")).toMatchObject({ selected_id: "111", needs: "nothing" });
    await expect(selectAdAccount("t", "2220000")).rejects.toMatchObject({ code: "tiktok_ads_unknown_account" });
  });
});
