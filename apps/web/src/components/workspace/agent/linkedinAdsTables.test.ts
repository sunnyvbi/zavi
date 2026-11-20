import { describe, expect, it } from "vitest";
import { linkedinAdsAdsTable, linkedinAdsCampaignLinks, linkedinAdsCampaignTable, linkedinAdsChrome, linkedinAdsGroupTable, linkedinAdsKpis, linkedinCampaignPill, linkedinCampaignStates } from "./linkedinAdsTables";
import { campaignLinksOf, channelChrome, extraTableData, kpiFallbackMetrics } from "./legacyChannelActions";
import { formatMetricValue } from "../metrics/format";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = {
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  prev_period: { from: "2026-08-03", to: "2026-09-01" },
  account: { name: "Main", account_count: 1, campaign_count: 2, active_count: 1, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [
    { id: "c1", currency: "USD", name: "Live", status: "ACTIVE", spend: 0, clicks: 0, conversions: 0, cpa: null, url: "https://www.linkedin.com/campaignmanager/accounts/1/campaigns" },
    { id: "c2", currency: "USD", name: "Held", status: "PAUSED", spend: 0, clicks: 0, conversions: 0, cpa: null, url: "https://www.linkedin.com/campaignmanager/accounts/1/campaigns" },
  ],
};

describe("linkedin_ads problem banner during a LinkedIn outage", () => {
  it("a refresh that met an outage asks for a retry and offers no reconnect", () => {
    const chrome = linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_http_error", totals: null });
    expect(chrome?.problem?.reconnect).toBe(false);
    expect(chrome?.problem?.text).not.toMatch(/reconnect/i);
  });

  it("must catch: a real refusal still asks for a reconnect", () => {
    expect(linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_token_revoked", totals: null })?.problem?.reconnect).toBe(true);
  });
});

describe("linkedin_ads kpiFallback", () => {
  it("a wallet campaign LinkedIn no longer has leaves every tile standing, with its recorded spend", () => {
    const m = linkedinAdsKpis({ ...payload, wallet_error_code: null, totals: { ...zero, spend: 40 }, prev_totals: { ...zero, spend: 7 } });
    expect(m.map((x) => x.key)).toEqual(["spend", "leads", "cpl", "clicks", "cpc", "budget"]);
    expect(m[0]).toMatchObject({ value: 40, grounded: true });
  });

  it("must catch: a wallet read that really failed still hides the tiles", () => {
    expect(linkedinAdsKpis({ ...payload, wallet_error_code: "linkedin_ads_wallet_read_failed", totals: { ...zero, spend: 40 } })).toEqual([]);
  });

  it("spend in a foreign currency only in the earlier period draws no comparison, this period's money stays", () => {
    const m = linkedinAdsKpis({ ...payload, wallet_error_code: null, totals: { ...zero, spend: 100, clicks: 10, cpc: 10 }, prev_totals: { ...zero, spend: null, cpc: null, cpa: null, clicks: 20 } });
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    expect(byKey.spend).toMatchObject({ value: 100, grounded: true });
    expect(byKey.spend.prev_value).toBeNull();
    expect(byKey.clicks.prev_value).toBe(20);
    expect(byKey.cpc).toMatchObject({ value: 10 });
  });

  it("draws six tiles: counts as zero and undefined ratios as unmeasured when nothing ran", () => {
    const m = linkedinAdsKpis(payload);
    expect(m.map((x) => x.key)).toEqual(["spend", "leads", "cpl", "clicks", "cpc", "budget"]);
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    for (const k of ["spend", "leads", "clicks", "budget"]) expect(byKey[k]).toMatchObject({ value: 0, grounded: true });
    for (const k of ["cpl", "cpc"]) {
      expect(Number.isNaN(byKey[k].value)).toBe(true);
      expect(byKey[k].grounded).toBe(false);
    }
    expect(byKey.cpl.unmeasured).toBe(true);
    expect(byKey.cpc.unmeasured).toBe(true);
  });

  it("shows real numbers when the account spent", () => {
    const spent = { spend: 60, impressions: 10_000, clicks: 200, conversions: 7, leads: 5, ctr: 2, cpc: 0.3, cpa: 12 };
    const m = linkedinAdsKpis({ ...payload, totals: spent });
    expect(Object.fromEntries(m.map((x) => [x.key, x.value]))).toEqual({ spend: 60, leads: 5, cpl: 12, clicks: 200, cpc: 0.3, budget: 0 });
    expect(m.find((x) => x.key === "clicks")?.note).toBe("2.00% click-through rate");
  });

  it("draws nothing for an unconnected or failed read", () => {
    expect(linkedinAdsKpis({ ...payload, connected: false, totals: null })).toEqual([]);
    expect(linkedinAdsKpis({ ...payload, error_code: "linkedin_ads_read_failed" })).toEqual([]);
  });
});

describe("linkedin_ads campaigns table and chrome", () => {
  it("lists campaigns with their status and counts the active ones", () => {
    const [t] = linkedinAdsCampaignTable(payload);
    expect(t.rows.map((r) => [r.cells[0].text, r.cells[1].text])).toEqual([["Live", "Active"], ["Held", "Paused"]]);
    expect(t.footer?.[0]?.text).toBe("1 active of 2");
    expect(t.caption).toBeUndefined();
    expect(linkedinAdsCampaignLinks(payload).Live).toContain("linkedin.com/campaignmanager");
  });

  it("names the account and offers a reconnect on a revoked token", () => {
    expect(linkedinAdsChrome(payload)?.account).toEqual({ name: "Main", sub: "1 active campaign" });
    const chrome = linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_token_revoked" });
    expect(chrome?.problem).toMatchObject({ reconnect: true });
  });

  it("a LinkedIn 403 tells the founder to get a role on the ad account, never to Refresh, and leaks no scope or status", () => {
    const problem = linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_forbidden" })?.problem;
    expect(problem?.text).toBe(
      "LinkedIn did not let Zavi read this ad account. Ask an account admin in LinkedIn Campaign Manager to give your LinkedIn user a role on it, or reconnect with a LinkedIn user who already has one.",
    );
    expect(problem?.reconnect).toBe(true);
    expect(problem?.text).not.toMatch(/r_ads|rw_ads|403|scope|HTTP|Refresh/i);
  });

  it("a connected workspace with no chosen account is told why the page is empty, without a reconnect; an unconnected one and a read failure are not", () => {
    const none = { ...payload, account: null, totals: null, campaigns: [] };
    expect(linkedinAdsChrome(none)?.problem).toEqual({
      text: "Connect your ad account to get started. LinkedIn is connected, but this workspace has no ad account yet, so Zavi cannot show numbers or run campaigns.",
      reconnect: false,
      settings: "Connect ad account",
    });
    expect(linkedinAdsChrome({ ...none, wallet_offered: true })?.problem).toEqual({
      text: "Choose how to run LinkedIn ads to get started. Use your own LinkedIn ad account, or let Zavi run them and pay from your shared wallet. You need one, not both.",
      reconnect: false,
      settings: "Set up ads account",
    });
    expect(linkedinAdsChrome({ ...none, wallet_offered: false })?.problem?.text).not.toMatch(/wallet/i);
    const held = linkedinAdsChrome({ ...none, held_elsewhere: ["Acme Ads"] })?.problem;
    expect(held?.text).toMatch(/^Your LinkedIn ad account Acme Ads is already connected to another Zavi workspace, so you cannot use it here\./);
    expect(held?.settings).toBeUndefined();
    expect(held?.reconnect).toBe(false);
    expect(held?.text).not.toMatch(/wallet/i);
    expect(linkedinAdsChrome({ ...none, held_elsewhere: ["A", "B"], wallet_offered: true })?.problem?.text).toMatch(/accounts A, B are already connected.*cannot use them here.*shared wallet/);
    expect(linkedinAdsChrome({ ...none, held_elsewhere: [] })?.problem?.settings).toBe("Connect ad account");
    expect(linkedinAdsChrome(none)?.problem?.text).not.toMatch(/has not|not chosen|could not|error/i);
    expect(linkedinAdsChrome({ ...none, connected: false })?.problem).toBeNull();
    expect(linkedinAdsChrome({ ...none, error_code: "linkedin_ads_read_failed" })?.problem?.text).toMatch(/could not read/);
    expect(linkedinAdsChrome(payload)?.problem).toBeNull();
  });

  it("wallet campaigns still show when the founder's own LinkedIn is not connected, with a way to connect it", () => {
    const wallet = { ...payload, own_connected: false };
    const chrome = linkedinAdsChrome(wallet);
    expect(chrome?.connected).toBe(true);
    expect(chrome?.problem).toEqual({
      text: "Your LinkedIn account is not connected, so this page shows only the campaigns Zavi runs from your shared wallet. Connect LinkedIn to see your own ad accounts here too.",
      reconnect: true,
      firstConnect: true,
    });
    expect(linkedinAdsKpis(wallet).length).toBeGreaterThan(0);
    expect(linkedinAdsChrome({ ...payload, own_connected: true })?.problem).toBeNull();
    expect(linkedinAdsChrome({ ...payload, own_connected: false, connected: false, account: null, totals: null, campaigns: [] })?.connected).toBe(false);
  });

  it.each([
    ["the whole read", { error_code: "linkedin_ads_daily_limit" }],
  ])("a used-up daily limit on %s gives the cause and the reset time, not Refresh in a minute", (_label, over) => {
    const text = linkedinAdsChrome({ ...payload, ...over })?.problem?.text;
    expect(text).toContain("daily allowance");
    expect(text).toContain("00:00 UTC (5:30 AM IST)");
    expect(text).not.toMatch(/in a minute/);
  });

  it("a rate limit or a LinkedIn outage still says to try again shortly, without a reconnect", () => {
    expect(linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_rate_limited" })?.problem).toEqual({
      text: "LinkedIn Ads is limiting requests. Wait a minute, then try Refresh.",
      reconnect: false,
    });
    expect(linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_http_error" })?.problem).toEqual({
      text: "Zavi could not read your LinkedIn Ads account just now. Try Refresh in a minute.",
      reconnect: false,
    });
  });
});

describe("linkedin_ads status reads the ads, not only the campaign", () => {
  const withAds = (over: Record<string, unknown>) => ({
    ...payload,
    campaigns: [{ ...payload.campaigns[0], ...over }],
  });
  const statusOf = (over: Record<string, unknown>) => linkedinAdsCampaignTable(withAds(over))[0].rows[0].cells[1];

  it("only an ad LinkedIn says is serving earns the green Live", () => {
    expect(statusOf({ ad_delivery: "serving", ads_not_running: 0 })).toEqual({ text: "Live", chip: "good" });
  });

  it.each([
    ["rejected", "Ads rejected", "bad"],
    ["in_review", "Ads in review", "warn"],
    ["held", "Ads on hold", "warn"],
    ["no_ads", "No ad running", "warn"],
  ])("%s never reads as Active or green", (ad_delivery, text, chip) => {
    const cell = statusOf({ ad_delivery, ads_not_running: 1 });
    expect(cell).toMatchObject({ text, chip });
    expect(cell.text).not.toMatch(/active/i);
  });

  it("a live campaign with one rejected ad says so instead of a clean green", () => {
    expect(statusOf({ ad_delivery: "serving", ads_not_running: 1 })).toEqual({ text: "Live, 1 ad not running", chip: "warn" });
    expect(statusOf({ ad_delivery: "serving", ads_not_running: 2 }).text).toBe("Live, 2 ads not running");
  });

  it.each([["unread"], [null], [undefined]])("must catch: ads state %s is never green", (ad_delivery) => {
    const cell = statusOf({ ad_delivery });
    expect(cell).toMatchObject({ text: "Active", chip: "muted" });
    expect(cell.chip).not.toBe("good");
  });

  it("must catch: a rejected campaign can still be paused, since LinkedIn still calls it ACTIVE", async () => {
    const [t] = linkedinAdsCampaignTable(withAds({ ad_delivery: "rejected", ad_account_id: "9" }), { canPause: true, propose: async () => {} });
    expect(t.rows[0].actions?.map((a) => a.label)).toEqual(["Pause", "Copy"]);
  });

  it("the fallback footer count leaves out a campaign whose ads are stopped, and a paused campaign shows no ad state", () => {
    const stopped = {
      ...payload,
      account: { name: "Main", account_count: 1, campaign_count: 2, currency: "USD" },
      campaigns: [
        { ...payload.campaigns[0], ad_delivery: "rejected" },
        { ...payload.campaigns[1], id: "c3", name: "Serving", status: "ACTIVE", ad_delivery: "serving" },
        { ...payload.campaigns[1], ad_delivery: null },
      ],
    };
    const [t] = linkedinAdsCampaignTable(stopped);
    expect(t.footer?.[0]?.text).toBe("1 active of 3");
    expect(t.rows[2].cells[1]).toEqual({ text: "Paused", chip: "muted" });
  });
});

describe("the generic lane delegates linkedin_ads to these adapters", () => {
  it("routes the id and the payload through every resolver", () => {
    expect(kpiFallbackMetrics("linkedin_ads", payload)).toEqual(linkedinAdsKpis(payload));
    expect(channelChrome("linkedin_ads", payload)).toEqual(linkedinAdsChrome(payload));
    expect(extraTableData("campaign_table", payload)).toEqual(linkedinAdsCampaignTable(payload));
    expect(campaignLinksOf(payload)).toEqual(linkedinAdsCampaignLinks(payload));
  });
});

describe("linkedin_ads when the shared-wallet campaigns could not be read", () => {
  const ownOnly = {
    ...payload,
    wallet_error_code: "linkedin_ads_wallet_read_failed",
    totals: { spend: 40, impressions: 5000, clicks: 100, conversions: 4, ctr: 2, cpc: 0.4, cpa: 10 },
  };

  it("never draws own-account totals as the whole spend and CPA, and says the wallet campaigns are missing", () => {
    expect(kpiFallbackMetrics("linkedin_ads", ownOnly)).toEqual([]);
    const chrome = channelChrome("linkedin_ads", ownOnly);
    expect(chrome?.problem).toEqual({ text: expect.stringMatching(/shared ads balance pays for.*missing/), reconnect: false });
    expect(chrome?.connected).toBe(true);
  });

  it("keeps the readable own-account rows but captions the table with what is missing", () => {
    const [t] = extraTableData("campaign_table", ownOnly) as ReturnType<typeof linkedinAdsCampaignTable>;
    expect(t.rows.map((r) => r.cells[0].text)).toEqual(["Live", "Held"]);
    expect(t.caption).toMatch(/shared ads balance pays for.*missing/);
  });

  it("names the wallet failure, not a generic account failure, when only wallet campaigns exist and none could be read", () => {
    const walletOnly = { ...payload, error_code: "linkedin_ads_wallet_read_failed", wallet_error_code: "linkedin_ads_wallet_read_failed", account: null, totals: null, campaigns: [] };
    expect(linkedinAdsChrome(walletOnly)?.problem?.text).toMatch(/shared ads balance pays for/);
    expect(linkedinAdsKpis(walletOnly)).toEqual([]);
  });

  it("a revoked LinkedIn token still asks for a reconnect even while the wallet read also failed", () => {
    expect(linkedinAdsChrome({ ...ownOnly, error_code: "linkedin_ads_token_revoked" })?.problem).toMatchObject({ reconnect: true });
  });

  it("shows the totals again once the wallet read recovers", () => {
    expect(linkedinAdsKpis({ ...ownOnly, wallet_error_code: null })).toHaveLength(6);
    expect(linkedinAdsChrome({ ...ownOnly, wallet_error_code: null })?.problem).toBeNull();
  });
});

describe("the campaign list's pill reads the same LinkedIn answer as the table", () => {
  it("an out of budget campaign says so on the table and is not counted active", () => {
    const [table] = linkedinAdsCampaignTable({
      platform: "linkedin_ads",
      connected: true,
      error_code: null,
      window_days: 30,
      account: { name: "A", account_count: 1, campaign_count: 1, active_count: 0, currency: "USD" },
      totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null },
      campaigns: [{ id: "1", currency: "USD", name: "C", status: "ACTIVE", ad_delivery: "out_of_budget", ads_not_running: 1, spend: 0, clicks: 0, conversions: 0, cpa: null, url: null }],
    });
    expect(JSON.stringify(table.rows)).toContain("Out of budget");
  });

  it("publishes nothing from an unconnected or failed read, so a failure cannot leave a false state", () => {
    const row = { id: "1", status: "PAUSED" };
    expect(linkedinCampaignStates({ platform: "linkedin_ads", connected: false, error_code: null, campaigns: [row] })).toEqual({});
    expect(linkedinCampaignStates({ platform: "linkedin_ads", connected: true, error_code: "linkedin_ads_read_failed", campaigns: [row] })).toEqual({});
    expect(linkedinCampaignStates({ platform: "reddit_ads", connected: true, error_code: null, campaigns: [row] })).toEqual({});
    expect(linkedinCampaignStates({ platform: "linkedin_ads", connected: true, error_code: null, campaigns: [row] })).toEqual({ "1": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } });
  });

  it.each(["COMPLETED", "ARCHIVED", "CANCELED", "REMOVED"])("%s reads Ended, never the stored Paused", (status) => {
    expect(linkedinCampaignPill({ status, ad_delivery: null, ads_not_running: 0 })).toEqual({ label: "Ended" });
  });
  it("an unknown LinkedIn status gives no pill rather than a guess", () => {
    expect(linkedinCampaignPill({ status: "PENDING_DELETION", ad_delivery: null, ads_not_running: 0 })).toBeNull();
  });
});

describe("linkedin_ads own account problems while wallet campaigns still read", () => {
  const wallet = { ...payload, campaigns: [{ ...payload.campaigns[0], id: "w1", name: "Wallet run" }] };

  it("a revoked own connection says the own accounts are missing, the wallet rows still show, and offers Reconnect, while the table and tiles stay", () => {
    const p = { ...wallet, own_error_code: "linkedin_ads_token_revoked" };
    expect(linkedinAdsChrome(p)?.problem).toEqual({
      text: "Your own LinkedIn connection stopped working, so your own ad accounts are missing here. Campaigns Zavi runs from your shared wallet still show. Reconnect to bring your accounts back.",
      reconnect: true,
    });
    expect(linkedinAdsCampaignTable(p)[0].rows.map((r) => r.id)).toEqual(["w1"]);
    expect(linkedinAdsKpis(p).length).toBe(6);
    expect(Object.keys(linkedinCampaignStates(p))).toEqual(["w1"]);
  });

  it.each([
    ["linkedin_ads_forbidden", true, /your own ad accounts, so they are missing here\. Campaigns Zavi runs from your shared wallet still show/],
    ["linkedin_ads_daily_limit", false, /own LinkedIn connection is used up, so your own ad accounts are missing here\. Campaigns Zavi runs from your shared wallet still show\. It resets at 00:00 UTC/],
    ["linkedin_ads_rate_limited", false, /your own ad accounts are missing here\. Campaigns Zavi runs from your shared wallet still show\. Wait a minute/],
    ["linkedin_ads_read_failed", false, /could not read your own LinkedIn ad accounts just now, so they are missing here/],
  ])("own %s names the own accounts as missing, never the whole page", (code, reconnect, text) => {
    const problem = linkedinAdsChrome({ ...wallet, own_error_code: code })?.problem;
    expect(problem?.reconnect).toBe(reconnect);
    expect(problem?.text).toMatch(text);
    expect(linkedinAdsCampaignTable({ ...wallet, own_error_code: code })).toHaveLength(1);
  });

  it("an own ad account that is not active, or closed, says what to do in LinkedIn with no Reconnect", () => {
    expect(linkedinAdsChrome({ ...wallet, own_error_code: "linkedin_ads_account_not_active" })?.problem).toEqual({
      text: "Your chosen LinkedIn ad account is not active in LinkedIn yet. Add a payment method to it in LinkedIn Campaign Manager, then try Refresh.",
      reconnect: false,
    });
    expect(linkedinAdsChrome({ ...wallet, own_error_code: "linkedin_ads_account_closed" })?.problem).toEqual({
      text: "Your chosen LinkedIn ad account is closed in LinkedIn. Choose another one in Settings, under Ad account and shared wallet.",
      reconnect: false,
    });
  });

  it("must not catch: a whole-page error_code still wins over the own code and still hides the table", () => {
    const p = { ...wallet, error_code: "linkedin_ads_token_revoked", own_error_code: "linkedin_ads_account_closed", totals: null };
    expect(linkedinAdsChrome(p)?.problem?.text).toBe("LinkedIn Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.");
    expect(linkedinAdsCampaignTable(p)).toEqual([]);
  });

  it("accounts that could not be read are named with their reason, and the totals are said to leave them out", () => {
    const one = linkedinAdsChrome({ ...payload, account_errors: [{ id: "9002", name: "EU account", reason: "LinkedIn is limiting requests right now. Try Refresh in a minute." }] })?.problem;
    expect(one).toEqual({
      text: "Zavi could not read one of your LinkedIn ad accounts, so the totals here leave it out. EU account: LinkedIn is limiting requests right now. Try Refresh in a minute.",
      reconnect: false,
    });
    const two = linkedinAdsChrome({ ...payload, account_errors: [{ id: "9002", name: "EU account", reason: "A." }, { id: "9003", name: "", reason: "B." }] })?.problem?.text;
    expect(two).toBe("Zavi could not read 2 of your LinkedIn ad accounts, so the totals here leave them out. EU account: A. 9003: B.");
    expect(linkedinAdsCampaignTable({ ...payload, account_errors: [{ id: "9002", name: "EU account", reason: "A." }] })).toHaveLength(1);
  });

  it("must not catch: no own code and no account errors leaves the page with no problem line", () => {
    expect(linkedinAdsChrome({ ...payload, own_error_code: null, account_errors: [] })?.problem).toBeNull();
  });
});

describe("the Campaigns table names a campaign the way the campaign rows above it do", () => {
  const tableStatus = (state: { status: string; ad_delivery?: string | null; ads_not_running?: number }) =>
    linkedinAdsCampaignTable({ ...payload, campaigns: [{ ...payload.campaigns[0], ...state }] })[0].rows[0].cells[1];

  it.each([
    ["ACTIVE", "serving", 0, "Live"],
    ["ACTIVE", "serving", 2, "Live, 2 ads not running"],
    ["PAUSED", null, 0, "Paused"],
    ["DRAFT", null, 0, "Paused"],
    ["COMPLETED", null, 0, "Ended"],
    ["ARCHIVED", null, 0, "Ended"],
    ["CANCELED", null, 0, "Ended"],
    ["REMOVED", null, 0, "Ended"],
    ["ACTIVE", "rejected", 1, "Ads rejected"],
    ["ACTIVE", "unread", 0, "Active"],
  ])("%s with ads %s (%s stopped) reads %s in both places", (status, ad_delivery, ads_not_running, label) => {
    const state = { status, ad_delivery: ad_delivery as never, ads_not_running };
    expect(linkedinCampaignPill(state)?.label).toBe(label);
    expect(tableStatus(state).text).toBe(label);
  });

  it("never shows LinkedIn's raw Draft, Completed, Archived or Canceled words", () => {
    for (const status of ["DRAFT", "COMPLETED", "ARCHIVED", "CANCELED", "CANCELLED", "REMOVED"]) {
      expect(tableStatus({ status, ad_delivery: null }).text).not.toMatch(/draft|completed|archived|cancel|removed/i);
    }
  });

  it("an unknown LinkedIn status still names itself in words, not in a raw code", () => {
    expect(tableStatus({ status: "PENDING_DELETION", ad_delivery: null })).toEqual({ text: "Pending deletion", chip: "muted" });
  });
});

describe("the Campaigns table spend keeps cents the way the Spend tile does", () => {
  const withSpend = (spend: number) => {
    const p = { ...payload, totals: { ...zero, spend }, campaigns: [{ ...payload.campaigns[0], spend }] };
    const [t] = linkedinAdsCampaignTable(p);
    const tile = linkedinAdsKpis(p).find((m) => m.key === "spend")!;
    return { row: t.rows[0].cells[3].text, footer: t.footer?.[3]?.text, tile: formatMetricValue(tile) };
  };

  it("a campaign that spent 40 cents reads $0.40, never $0", () => {
    expect(withSpend(0.4)).toEqual({ row: "$0.40", footer: "$0.40", tile: "$0.40" });
  });

  it.each([0, 0.4, 12, 12.5, 999.99, 1234.56, 25000])("spend %s reads the same in the row, the footer and the tile", (spend) => {
    const { row, footer, tile } = withSpend(spend);
    expect(row).toBe(tile);
    expect(footer).toBe(tile);
  });
});

describe("LinkedIn limits on Zavi's shared login name the shared-balance campaigns, not the founder's own connection", () => {
  const WALLET_DAILY = "Zavi's shared LinkedIn login has used up LinkedIn's daily allowance, so the campaigns your shared ads balance pays for are missing here. It resets at 00:00 UTC. Try Refresh after that.";
  const retryAt = "2026-11-03T10:45:00Z";
  const local = new Date(retryAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const walletOnly = (code: string, over: Record<string, unknown> = {}) => ({
    ...payload,
    own_connected: false,
    error_code: code,
    wallet_error_code: code,
    account: null,
    totals: null,
    campaigns: [],
    ...over,
  });

  it("a used-up allowance on the shared login says so, beside readable own rows and in the table caption", () => {
    const p = { ...payload, wallet_error_code: "linkedin_ads_wallet_daily_limit" };
    expect(linkedinAdsChrome(p)?.problem).toEqual({ text: WALLET_DAILY, reconnect: false });
    expect(linkedinAdsCampaignTable(p)[0].caption).toBe(WALLET_DAILY);
    expect(linkedinAdsKpis(p)).toEqual([]);
  });

  it("must catch: a wallet-only founder whose shared login hit the daily limit sees that, not a connect prompt or 'your own connection'", () => {
    const problem = linkedinAdsChrome(walletOnly("linkedin_ads_wallet_daily_limit"))?.problem;
    expect(problem).toEqual({ text: WALLET_DAILY, reconnect: false });
    expect(problem?.text).not.toMatch(/your own LinkedIn connection|this LinkedIn connection/);
  });

  it("only the founder's own connection keeps the 'your own LinkedIn connection' wording", () => {
    expect(linkedinAdsChrome({ ...payload, own_error_code: "linkedin_ads_daily_limit" })?.problem?.text).toMatch(/your own LinkedIn connection is used up/);
    expect(linkedinAdsChrome({ ...payload, wallet_error_code: "linkedin_ads_wallet_daily_limit" })?.problem?.text).not.toMatch(/own LinkedIn connection/);
  });

  it("a slow-down on the shared login names the local time Zavi reads again", () => {
    const p = { ...payload, wallet_error_code: "linkedin_ads_wallet_rate_limited", retry_at: retryAt };
    const text = `LinkedIn asked Zavi to slow down, so the campaigns your shared ads balance pays for are missing here. Zavi will read them again at ${local}. Try Refresh after that.`;
    expect(linkedinAdsChrome(p)?.problem).toEqual({ text, reconnect: false });
    expect(linkedinAdsCampaignTable(p)[0].caption).toBe(text);
    expect(linkedinAdsChrome(walletOnly("linkedin_ads_wallet_rate_limited", { retry_at: retryAt }))?.problem?.text).toBe(text);
  });

  it("a slow-down with no retry time falls back to waiting a minute", () => {
    expect(linkedinAdsChrome({ ...payload, wallet_error_code: "linkedin_ads_wallet_rate_limited", retry_at: null })?.problem?.text).toBe(
      "LinkedIn asked Zavi to slow down, so the campaigns your shared ads balance pays for are missing here. Wait a minute, then try Refresh.",
    );
  });

  it("the whole read and the own read use the retry time instead of 'wait a minute', and keep it when there is none", () => {
    expect(linkedinAdsChrome({ ...payload, error_code: "linkedin_ads_rate_limited", retry_at: retryAt })?.problem?.text).toBe(
      `LinkedIn Ads is limiting requests. Zavi will read it again at ${local}. Try Refresh after that.`,
    );
    const own = linkedinAdsChrome({ ...payload, own_error_code: "linkedin_ads_rate_limited", retry_at: retryAt })?.problem?.text;
    expect(own).toContain(`Zavi will read them again at ${local}. Try Refresh after that.`);
    expect(own).not.toMatch(/Wait a minute/);
    expect(linkedinAdsChrome({ ...payload, own_error_code: "linkedin_ads_rate_limited", retry_at: "not a date" })?.problem?.text).toMatch(/Wait a minute, then try Refresh\.$/);
  });
});

describe("campaigns LinkedIn no longer lists still show as rows that add up to the footer", () => {
  const others = [
    { kind: "ended", name: "Archived, canceled and older campaigns", currency: "USD", spend: 30.25, impressions: 900, clicks: 12, conversions: 2, cpa: 15.13 },
    { kind: "removed", name: "Campaigns no longer in LinkedIn", currency: "USD", spend: 7.5, impressions: null, clicks: null, conversions: null, cpa: null },
  ];
  const p = {
    ...payload,
    totals: { ...zero, spend: 50, clicks: 22, conversions: 3 },
    campaigns: [{ ...payload.campaigns[0], ad_account_id: "9001", spend: 12.25, clicks: 10, conversions: 1 }],
    other_campaigns: others,
  };

  it("adds an Ended row and a Removed row after the campaigns, with '–' where LinkedIn gave no number", () => {
    const [t] = linkedinAdsCampaignTable(p);
    expect(t.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Live", "Active", "—", "$12.25", "10", "1", "–", "-", "–", "–", "–", "-"],
      ["Archived, canceled and older campaigns", "Ended", "—", "$30.25", "12", "2", "–", "$15.13", "–", "900", "1.33%", "-"],
      ["Campaigns no longer in LinkedIn", "Removed", "—", "$7.50", "–", "–", "–", "–", "–", "–", "–", "-"],
    ]);
  });

  it("must catch: the rows add up to the footer's spend", () => {
    const [t] = linkedinAdsCampaignTable(p);
    const sum = t.rows.reduce((n, r) => n + Number(r.cells[3].text.replace(/[$,]/g, "")), 0);
    expect(sum).toBeCloseTo(50, 2);
    expect(t.footer?.[3]?.text).toBe("$50");
  });

  it("must catch: the extra rows get no pause button and never join the thumbnail batch", () => {
    const [t] = linkedinAdsCampaignTable(p, { canPause: true, propose: async () => {} });
    expect(t.rows[0].actions?.map((a) => a.label)).toEqual(["Pause", "Copy"]);
    for (const r of t.rows.slice(1)) {
      expect(r.actions).toBeUndefined();
      expect(r.cells[0].media).toBeUndefined();
    }
    const batch = (t.rows[0].cells[0].media as { props: { campaignIds: string } }).props.campaignIds;
    expect(batch).toBe("c1");
  });

  it("says there is no campaign only when both lists are empty", () => {
    const onlyOthers = linkedinAdsCampaignTable({ ...p, campaigns: [] })[0];
    expect(onlyOthers.rows).toHaveLength(2);
    expect(onlyOthers.footer?.[0]?.text).toBe("1 active of 0");
    const none = linkedinAdsCampaignTable({ ...p, campaigns: [], other_campaigns: [] })[0];
    expect(none.rows).toEqual([]);
    expect(none.empty).toBe("No LinkedIn campaign in this account yet.");
  });
});

describe("spend LinkedIn only reported as a monthly total is called out, not silently dropped", () => {
  const NOW = "$42.50 of spend from campaigns no longer in LinkedIn is left out of this range: LinkedIn only gave Zavi a monthly total for them, so Zavi cannot split it by day.";
  const BEFORE = "$1,235 of spend from campaigns no longer in LinkedIn is left out of the comparison range for the same reason.";

  it("captions the table with what is left out of this range and of the comparison", () => {
    expect(linkedinAdsCampaignTable({ ...payload, left_out_spend: { now: 42.5, before: 0 } })[0].caption).toBe(NOW);
    expect(linkedinAdsCampaignTable({ ...payload, left_out_spend: { now: 0, before: 1234.56 } })[0].caption).toBe(BEFORE);
    expect(linkedinAdsCampaignTable({ ...payload, left_out_spend: { now: 42.5, before: 1234.56 } })[0].caption).toBe(`${NOW} ${BEFORE}`);
  });

  it("says nothing when nothing is left out, and keeps the wallet note alongside", () => {
    expect(linkedinAdsCampaignTable({ ...payload, left_out_spend: { now: 0, before: 0 } })[0].caption).toBeUndefined();
    expect(linkedinAdsCampaignTable({ ...payload, wallet_error_code: "linkedin_ads_wallet_read_failed", left_out_spend: { now: 42.5, before: 0 } })[0].caption).toMatch(/shared ads balance pays for.*missing.* \$42\.50 of spend/);
  });
});

describe("the Campaigns table groups ad sets under their LinkedIn campaign group, like Meta", () => {
  const adSet = (id: string, group: { id: string; name: string } | null, over: Record<string, unknown> = {}) => ({
    id,
    ad_account_id: "9",
    currency: "USD",
    name: `Ad set ${id}`,
    status: "ACTIVE",
    campaign_group: group,
    spend: 10,
    clicks: 5,
    conversions: 1,
    leads: 2,
    conversion_value: 40,
    cpa: 10,
    url: null,
    ...over,
  });
  const spring = { id: "5", name: "Spring launch" };
  const always = { id: "6", name: "Always on" };
  const grouped = {
    ...payload,
    totals: { ...zero, spend: 999 },
    account: { ...payload.account, active_count: 4 },
    campaigns: [adSet("a", spring, { spend: 12.5, clicks: 4, conversions: 1, leads: 1, conversion_value: 30 }), adSet("b", always), adSet("c", spring, { spend: 20, clicks: 6, conversions: 0, leads: 3, conversion_value: 20, cpa: null }), adSet("d", null, { spend: 1, clicks: 1, conversions: 0, leads: 0, conversion_value: 0, cpa: null })],
  };
  const texts = (t: ReturnType<typeof linkedinAdsCampaignTable>[number]) => t.rows.map((r) => r.cells.map((c) => c.text));

  it("labels the rows Ad set and shows Clicks, Conv., Leads, CPA and Conv. value", () => {
    const [t] = linkedinAdsCampaignTable(grouped);
    expect(t.columns.map((c) => c.label)).toEqual(["Ad set", "Status", "Daily budget", "Spend", "Clicks", "Conv.", "Leads", "CPA", "Conv. value", "Impressions", "Click-through rate", "Cost per lead"]);
  });

  const views = (t: ReturnType<typeof linkedinAdsCampaignTable>[number]) => Object.fromEntries((t.views ?? []).map((v) => [v.id, v]));
  const campaignsOf = (t: ReturnType<typeof linkedinAdsCampaignTable>[number]) => views(t).campaigns.data!;

  it("must catch: grouped ad sets give a Campaigns view and an Ad sets view, Campaigns first, and the two never mix", () => {
    const [t] = linkedinAdsCampaignTable(grouped);
    expect(t.title).toBe("Campaigns and ad sets");
    expect(t.views?.map((v) => [v.id, v.label])).toEqual([["campaigns", "Campaigns"], ["ad_sets", "Ad sets"]]);
    expect(views(t).ad_sets.data).toBeUndefined();
    expect(t.rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(campaignsOf(t).rows.map((r) => r.id)).toEqual(["group:5", "group:6", "other"]);
  });

  it("must catch: each campaign row is the sum of its ad sets, campaigns come biggest first, and ad sets with no live group land under Other last", () => {
    const c = campaignsOf(linkedinAdsCampaignTable(grouped)[0]);
    expect(c.columns.map((x) => x.label)).toEqual(["Campaign", "Ad sets", "Daily budget", "Spend", "Clicks", "Conv.", "Leads", "CPA", "Conv. value", "Impressions", "Click-through rate", "Cost per lead"]);
    expect(c.rows.map((r) => r.cells.map((x) => x.text))).toEqual([
      ["Spring launch", "2 ad sets", "—", "$32.50", "10", "1", "4", "$32.50", "$50", "–", "–", "$8.13"],
      ["Always on", "1 ad set", "—", "$10", "5", "1", "2", "$10.00", "$40", "–", "–", "$5.00"],
      ["Other", "1 ad set", "—", "$1", "1", "0", "0", "-", "$0", "–", "–", "-"],
    ]);
    expect(c.rows[0].cells[0].strong).toBe(true);
    expect(c.rows[2].cells[0].title).toMatch(/archived, canceled or could not be read/);
    expect(c.footer?.map((x) => x.text)).toEqual(["2 campaigns", "4 ad sets", "—", "$43.50", "16", "2", "6", "$21.75", "$90", "–", "–", "$7.25"]);
  });

  it("must catch: every ad set row names its campaign under it, and a row with no live group names none", () => {
    const [t] = linkedinAdsCampaignTable(grouped);
    expect(texts(t)).toEqual([
      ["Ad set a", "Active", "—", "$12.50", "4", "1", "1", "$10.00", "$30", "–", "–", "$12.50"],
      ["Ad set b", "Active", "—", "$10", "5", "1", "2", "$10.00", "$40", "–", "–", "$5.00"],
      ["Ad set c", "Active", "—", "$20", "6", "0", "3", "-", "$20", "–", "–", "$6.67"],
      ["Ad set d", "Active", "—", "$1", "1", "0", "0", "-", "$0", "–", "–", "-"],
    ]);
    expect(t.rows.map((r) => r.cells[0].sub)).toEqual(["Spring launch", "Always on", "Spring launch", undefined]);
  });

  it("must catch: the footer is the sum of the ad set rows shown, not the payload total", () => {
    const [t] = linkedinAdsCampaignTable(grouped);
    expect(t.footer?.map((c) => c.text)).toEqual(["4 active of 4", "", "—", "$43.50", "16", "2", "6", "$21.75", "$90", "–", "–", "$7.25"]);
  });

  it("must catch: the pause action sits on ad set rows only, and a campaign row shows its first ad set's preview", () => {
    const [t] = linkedinAdsCampaignTable(grouped, { canPause: true, propose: async () => {} });
    expect(t.rows.filter((r) => r.actions?.length).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    for (const r of campaignsOf(t).rows) {
      expect(r.actions).toBeUndefined();
      expect((r.cells[0].media as { props: { campaignId: string } }).props.campaignId).toBe(grouped.campaigns.find((c) => (c.campaign_group ? `group:${c.campaign_group.id}` : "other") === r.id)?.id);
    }
    expect((t.rows[0].cells[0].media as { props: { campaignIds: string } }).props.campaignIds).toBe("a,b,c,d");
  });

  it("when no ad set has a group, the table stays flat with no Other row and no view switch", () => {
    const [t] = linkedinAdsCampaignTable({ ...grouped, campaigns: [adSet("d", null), adSet("e", null)] });
    expect(t.rows.map((r) => r.id)).toEqual(["d", "e"]);
    expect(t.views).toBeUndefined();
    expect(t.title).toBe("Campaigns");
  });

  it("must catch: a leads or conversion value LinkedIn left out reads – on the row and keeps the footer honest", () => {
    const [t] = linkedinAdsCampaignTable({ ...grouped, campaigns: [adSet("a", spring, { leads: null, conversion_value: null }), adSet("b", spring)] });
    expect(campaignsOf(t).rows[0].cells.map((x) => x.text)).toEqual(["Spring launch", "2 ad sets", "—", "$20", "10", "2", "–", "$10.00", "–", "–", "–", "-"]);
    expect(texts(t)[0].slice(6, 9)).toEqual(["–", "$10.00", "–"]);
    expect(campaignsOf(t).footer?.[8]).toEqual({ text: "–" });
    expect(t.footer?.[6]).toEqual({ text: "–" });
    expect(t.footer?.[8]).toEqual({ text: "–" });
    expect(t.footer?.[4]).toEqual({ text: "10" });
  });

  it("must catch: an ad set shows its own daily budget, and a campaign and the footer add up only the ad sets that are on", () => {
    const [t] = linkedinAdsCampaignTable({
      ...grouped,
      campaigns: [
        adSet("a", spring, { daily_budget: 25 }),
        adSet("b", spring, { daily_budget: 15, status: "PAUSED" }),
        adSet("c", always, { daily_budget: 40.5 }),
        adSet("d", always, { daily_budget: null }),
      ],
    });
    const budgetOf = (rows: string[][]) => Object.fromEntries(rows.map((r) => [r[0], r[2]]));
    expect(budgetOf(texts(t))).toMatchObject({ "Ad set a": "$25 / day", "Ad set b": "$15 / day", "Ad set c": "$40.50 / day", "Ad set d": "—" });
    expect(t.footer?.[2]?.text).toBe("$65.50 / day");
    const c = campaignsOf(t);
    expect(budgetOf(c.rows.map((r) => r.cells.map((x) => x.text)))).toMatchObject({ "Spring launch": "$25 / day", "Always on": "$40.50 / day" });
    expect(c.footer?.[2]?.text).toBe("$65.50 / day");
    const allOff = linkedinAdsCampaignTable({ ...grouped, campaigns: [adSet("a", spring, { daily_budget: 25, status: "PAUSED" })] })[0];
    expect(allOff.footer?.[2]?.text).toBe("—");
    expect(texts(allOff)[0][2]).toBe("$25 / day");
  });

  it("must catch: both views page by 10 and the Ad sets view holds only ad sets", () => {
    const many = Array.from({ length: 11 }, (_, i) => adSet(`s${i}`, i < 6 ? spring : always));
    const [t] = linkedinAdsCampaignTable({ ...grouped, campaigns: many });
    expect(t.rows).toHaveLength(11);
    expect(t.rows.every((r) => !r.id.startsWith("group:"))).toBe(true);
    expect(t.pageSize).toBe(10);
    expect(campaignsOf(t).rows).toHaveLength(2);
    expect(campaignsOf(t).pageSize).toBe(10);
  });
});

describe("the Campaign groups and Ads tables resolve through their own extras ids and carry the row buttons", () => {
  const groups = [
    { id: "g5", ad_account_id: "9001", name: "Spring launch", status: "ACTIVE", total_budget: { amount: 500, currency: "USD" }, run_end_at: null, is_default: false, campaign_count: 2 },
    { id: "g6", ad_account_id: "9001", name: "Default Campaign Group", status: "ACTIVE", total_budget: null, run_end_at: null, is_default: true, campaign_count: 0 },
    { id: "g7", ad_account_id: "9001", name: "Winter", status: "PAUSED", total_budget: null, run_end_at: null, is_default: false, campaign_count: 0 },
  ];
  const ads = [
    { id: "701", campaign_id: "c1", ad_account_id: "9001", name: "Hero post", intended_status: "ACTIVE", is_serving: true, review_status: "APPROVED", hold_reasons: [] },
    { id: "702", campaign_id: "c1", ad_account_id: "9001", name: "Second", intended_status: "ACTIVE", is_serving: false, review_status: "APPROVED", hold_reasons: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] },
    { id: "703", campaign_id: "c2", ad_account_id: "9001", name: "Resting", intended_status: "PAUSED", is_serving: false, review_status: null, hold_reasons: [] },
  ];
  const rich = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], ad_account_id: "9001", campaign_group: { id: "g5", name: "Spring launch" }, spend: 30 },
      { ...payload.campaigns[1], ad_account_id: "9001", campaign_group: { id: "g5", name: "Spring launch" }, spend: 12.5 },
    ],
    groups,
    ads,
  };

  it("campaign_group_table and ads_table answer the same tables the adapters build, and only for owners and admins do rows carry buttons", () => {
    const shape = (tables: ReturnType<typeof linkedinAdsGroupTable>) => tables.map((t) => ({ ...t, rows: t.rows.map((r) => ({ ...r, actions: r.actions?.map((a) => a.label) })) }));
    expect(shape(extraTableData("campaign_group_table", rich, undefined, { role: "owner" }))).toEqual(shape(linkedinAdsGroupTable(rich, { canPause: true })));
    expect(shape(extraTableData("ads_table", rich, undefined, { role: "admin" }))).toEqual(shape(linkedinAdsAdsTable(rich, { canPause: true })));
    expect(extraTableData("campaign_group_table", rich, undefined, { role: "owner" })[0].rows[0].actions?.length).toBe(2);
    const member = extraTableData("campaign_group_table", rich, undefined, { role: "member" });
    expect(member[0].rows.every((r) => r.actions === undefined)).toBe(true);
    expect(extraTableData("ads_table", rich, undefined, { role: "member" })[0].rows.every((r) => r.actions === undefined)).toBe(true);
    expect(extraTableData("campaign_group_table", { platform: "tiktok_ads", connected: true }, undefined, { role: "owner" })).toEqual([]);
    expect(extraTableData("ads_table", { platform: "meta_ads", channels: [] }, undefined, { role: "owner" })).toEqual([]);
  });

  it("must catch: a group row sums the spend of its ad sets, shows its budget, and the default group gets no button while others get pause or restart plus copy", () => {
    const [t] = linkedinAdsGroupTable(rich, { canPause: true });
    expect(t.title).toBe("Campaign groups");
    expect(t.columns.map((c) => c.label)).toEqual(["Group", "Status", "Ad sets", "Budget", "Spend"]);
    expect(t.narrow).toBe(true);
    const byId = Object.fromEntries(t.rows.map((r) => [r.id, r]));
    expect(byId.g5.cells.map((c) => c.text)).toEqual(["Spring launch", "Active", "2", "$500", "$42.50"]);
    expect(byId.g5.actions?.map((a) => a.label)).toEqual(["Pause", "Copy"]);
    expect(byId.g7.actions?.map((a) => a.label)).toEqual(["Restart", "Copy"]);
    expect(byId.g6.actions).toBeUndefined();
    expect(byId.g6.cells[0].sub).toBe("Default group");
    expect(byId.g6.cells[3].text).toBe("No cap");
    expect(t.rows.map((r) => r.id)).toEqual(["g5", "g6", "g7"]);
  });

  it("must catch: a group with no ad sets shows a dash, and a column every group leaves empty is dropped rather than repeating a filler word", () => {
    const groups = rich.groups.map((g, i) => ({ ...g, total_budget: null, run_end_at: i === 0 ? "2026-11-05T00:00:00Z" : null, campaign_count: i === 0 ? 0 : g.campaign_count }));
    const [t] = linkedinAdsGroupTable({ ...rich, groups }, { canPause: true });
    expect(t.columns.map((c) => c.label)).toEqual(["Group", "Status", "Ad sets", "Ends", "Spend"]);
    const first = t.rows.find((r) => r.id === groups[0].id)!;
    expect(first.cells[2].text).toBe("—");
    expect(first.cells[2].chip).toBeUndefined();
    expect(first.cells[3].text).toBe("Nov 5, 2026");
    const other = t.rows.find((r) => r.id !== groups[0].id)!;
    expect(other.cells[3].text).toBe("—");
    expect(t.rows.flatMap((r) => r.cells.map((c) => c.text))).not.toContain("0 ad sets");
    expect(t.rows.flatMap((r) => r.cells.map((c) => c.text))).not.toContain("No cap");
  });

  it("must catch: the ads table hides turn off on the only ad that is on in a running ad set, keeps it when another ad is on, and names the ad set", () => {
    const [t] = linkedinAdsAdsTable(rich, { canPause: true });
    expect(t.title).toBe("Ads");
    const byId = Object.fromEntries(t.rows.map((r) => [r.id, r]));
    expect(byId["701"].actions?.map((a) => a.label)).toEqual(["Turn off"]);
    expect(byId["702"].actions?.map((a) => a.label)).toEqual(["Turn off"]);
    expect(byId["702"].cells[2]).toMatchObject({ text: "Out of budget", chip: "warn" });
    expect(byId["703"].actions?.map((a) => a.label)).toEqual(["Turn on"]);
    expect(byId["703"].cells[1].text).toBe("Held");
    expect(byId["703"].cells[2]).toMatchObject({ text: "Off", chip: "muted" });
    const alone = linkedinAdsAdsTable({ ...rich, ads: [ads[0], ads[2]] }, { canPause: true })[0];
    expect(alone.rows.find((r) => r.id === "701")?.actions).toBeUndefined();
    const pausedCampaign = linkedinAdsAdsTable({ ...rich, campaigns: [{ ...rich.campaigns[0], status: "PAUSED" }, rich.campaigns[1]], ads: [ads[0]] }, { canPause: true })[0];
    expect(pausedCampaign.rows[0].actions?.map((a) => a.label)).toEqual(["Turn off"]);
  });

  it("must catch: an ads read that failed says so instead of claiming there is no ad", () => {
    const unread = linkedinAdsAdsTable({ ...rich, campaigns: [{ ...rich.campaigns[0], ad_delivery: "unread" }, rich.campaigns[1]], ads: [] }, { canPause: true })[0];
    expect(unread.rows).toEqual([]);
    expect(unread.empty).toMatch(/could not read/);
    expect(linkedinAdsAdsTable({ ...rich, ads: [] }, { canPause: true })[0].empty).toMatch(/^No ad in a running ad set/);
  });

  it("must catch: a live ad set gets pause + copy, a paused one restart + archive + copy, a draft archive + copy, an archived one nothing", () => {
    const of = (status: string) => linkedinAdsCampaignTable({ ...rich, campaigns: [{ ...rich.campaigns[0], status }] }, { canPause: true })[0].rows[0].actions?.map((a) => a.label);
    expect(of("ACTIVE")).toEqual(["Pause", "Copy"]);
    expect(of("PAUSED")).toEqual(["Restart", "Ask Zavi to archive", "Copy"]);
    expect(of("COMPLETED")).toEqual(["Restart", "Ask Zavi to archive", "Copy"]);
    expect(of("DRAFT")).toEqual(["Ask Zavi to archive", "Copy"]);
    expect(of("ARCHIVED")).toBeUndefined();
  });
  describe("previews on every LinkedIn table", () => {
    type Thumb = { props: { campaignId: string; campaignIds: string; level?: string; fallbackId?: string } };
    const thumb = (cell: { media?: unknown }) => cell.media as Thumb | undefined;

    it("must catch: each ad shows its own image, asked for at ad level and keyed by the ad", () => {
      const [t] = linkedinAdsAdsTable(rich, { canPause: true });
      expect(t.rows.length).toBeGreaterThan(0);
      for (const r of t.rows) {
        const m = thumb(r.cells[0]);
        expect(m?.props.level).toBe("ad");
        expect(m?.props.campaignId).toBe(r.id);
        expect(m?.props.fallbackId).toBe(rich.ads.find((a) => a.id === r.id)?.campaign_id);
        expect(m?.props.campaignIds).toBe([...new Set(rich.ads.map((a) => a.campaign_id))].sort().join(","));
      }
    });

    it("must catch: a campaign shows its first ad set's preview, and a campaign with no ad set shows none", () => {
      const [t] = linkedinAdsGroupTable(rich, { canPause: true });
      for (const r of t.rows) {
        const first = rich.campaigns.find((c) => c.campaign_group?.id === r.id);
        const m = thumb(r.cells[0]);
        if (first) {
          expect(m?.props.campaignId).toBe(first.id);
          expect(m?.props.level).toBeUndefined();
        } else expect(m).toBeUndefined();
      }
      expect(t.rows.some((r) => thumb(r.cells[0]))).toBe(true);
    });
  });
});
