// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PaidAnalytics } from "./PaidAnalytics";
import { paidAnalyticsModel } from "./model";
import { ChannelPageProvider } from "../../layout/channelPage";
const api = vi.hoisted(() => ({ fetch: vi.fn(), meta: vi.fn(), google: vi.fn(), plan: vi.fn(), metaOn: vi.fn(), googleOn: vi.fn(), wait: vi.fn(), tiktokStatus: vi.fn(), tiktokOpen: vi.fn(), tiktokNew: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: api.plan }));
vi.mock("../managed-campaigns/api", () => ({ campaignFetch: api.fetch }));
vi.mock("../managed-campaigns/meta/metaEditorApi", () => ({ openMetaCampaignEditor: api.meta, setMetaCampaignOn: api.metaOn, waitForMetaChange: api.wait }));
vi.mock("../managed-campaigns/google/googleEditorApi", () => ({ openGoogleCampaignEditor: api.google, setGoogleCampaignOn: api.googleOn, waitForGoogleChange: api.wait }));
vi.mock("../tiktok-campaigns/requestStatus", () => ({ requestTiktokCampaignStatus: api.tiktokStatus }));
vi.mock("../tiktok-campaigns/openCampaign", () => ({ openTiktokCampaign: api.tiktokOpen, openNewTiktokCampaign: api.tiktokNew }));
vi.mock("../topActions/BoostPostModal", () => ({ BoostPostModal: ({ channelName }: { channelName: string }) => <div role="dialog">Boost {channelName}</div> }));
const extra = { channelName: "Meta Ads", onChanged: () => undefined };
const payload = {
  currency: "INR", period: { from: "2026-10-01", to: "2026-10-30" },
  kpis: [{ key: "spend", value: 300 }, { key: "conversions", value: 2.5 }],
  campaigns: [{ id: "11", name: "Search campaign", status: "ENABLED", channel_type: "SEARCH", spend: 300, conversions: 2.5, cpa: 120, conv_value: 500, daily_budget: 50, budget_shared: true }, { id: "12", name: "Second campaign", status: "ENABLED", channel_type: "SEARCH", spend: 0, conversions: 0, cpa: null, conv_value: 0, daily_budget: 50, budget_shared: true }],
  daily_budget: { total_daily_budget_usd: 50, active_campaigns: 2 },
};
const change = { label: "x", decision_id: "d1", approved: true, code: null };
const metaPayload = (status: string) => ({ meta_currency: "USD", channels: [{ channel: "meta", connected: true, spend_usd: 1, conversions: 1, revenue_usd: 1, cpa_usd: 1, roas: 2.21, ctr_percent: 1 }], connected: { meta: true }, campaigns: [{ channel: "meta", campaign_id: "9", campaign_name: "Reach", status, spend_usd: 1, active_daily_budget_usd: 20 }] });
beforeEach(() => { vi.clearAllMocks(); api.fetch.mockResolvedValue({ rows: [], currency: "INR", complete: true }); api.metaOn.mockResolvedValue(change); api.googleOn.mockResolvedValue(change); api.wait.mockResolvedValue({ state: "done" }); });
afterEach(cleanup);
it("preserves fractional conversions, shared budget totals and actual currency", () => {
  const model = paidAnalyticsModel("google", payload);
  expect(model.budget).toBe(50);
  expect(model.metrics.find(m => m.key === "conversions")?.value).toBe(2.5);
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit={false} refreshing={false} {...extra} />);
  expect(screen.getAllByText("INR 300").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /Edit campaign/ })).toBeNull();
  expect(api.fetch).not.toHaveBeenCalled();
});
it("does not invent zero metrics or assume dollars when a report is unavailable", () => {
  const model = paidAnalyticsModel("meta", { channels: [{ channel: "meta", spend_usd: 0 }], channel_errors: { meta: { code: "refused" } }, campaigns: [] });
  expect(model.readable).toBe(false);
  expect(model.metrics.every(m => m.value === null)).toBe(true);
  expect(model.budget).toBeNull();
  expect(model.currency).toBeNull();
});
it("reads only the selected campaign and uses the exact parent report window", async () => {
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(1));
  const url = new URL(api.fetch.mock.calls[0][0], "https://local.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({ campaign_id: "11", level: "groups", since: "2026-10-01", until: "2026-10-30" });
  fireEvent.change(screen.getByLabelText("Campaign for detailed results"), { target: { value: "12" } });
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(2));
  expect(api.fetch.mock.calls[1][0]).toContain("campaign_id=12");
});
it("a rejected read offers retry instead of claiming there are no ads", async () => {
  api.fetch.mockRejectedValueOnce(new Error("unavailable"));
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ads" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("No results were returned for this selection.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(2));
});
it("editing opens the existing editor and performs no write", () => {
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit campaign for Search campaign" }));
  expect(api.google).toHaveBeenCalledWith({ campaign_id: "11" });
  expect(api.fetch).not.toHaveBeenCalled();
});
it("hides unsupported Google types without blocking valid non-video campaigns", () => {
  const video = { ...payload.campaigns[1], id: "13", name: "Classic video", channel_type: "VIDEO" };
  const missing = { ...payload.campaigns[1], id: "14", name: "Missing type", channel_type: null };
  const unknown = { ...payload.campaigns[1], id: "15", name: "Unknown type", channel_type: "UNKNOWN" };
  const hotel = { ...payload.campaigns[1], id: "16", name: "Hotel campaign", channel_type: "HOTEL" };
  render(<PaidAnalytics kind="google" payload={{ ...payload, campaigns: [payload.campaigns[0], video, missing, unknown, hotel] }} days={30} canEdit refreshing={false} {...extra} />);
  expect(screen.queryByRole("button", { name: "Edit campaign for Classic video" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit campaign for Missing type" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit campaign for Unknown type" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit campaign for Hotel campaign" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  const chooser = within(screen.getByRole("region", { name: "Choose a campaign budget" }));
  expect(chooser.queryByText("Classic video")).toBeNull();
  expect(chooser.queryByText("Missing type")).toBeNull();
  expect(chooser.queryByText("Unknown type")).toBeNull();
  expect(chooser.getByText("Search campaign")).toBeTruthy();
  expect(chooser.getByText("Hotel campaign")).toBeTruthy();
});
it("Create campaign and Boost a post reuse the existing editor and boost flow, owners and admins only", () => {
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
  expect(api.google).toHaveBeenCalledWith("new");
  expect(screen.queryByRole("button", { name: "Boost a post" })).toBeNull();
  cleanup();
  render(<PaidAnalytics kind="meta" payload={{ channels: [{ channel: "meta", connected: true, spend_usd: 1, conversions: 1, revenue_usd: 1, cpa_usd: 1, roas: 1, ctr_percent: 1 }], connected: { meta: true }, campaigns: [{ channel: "meta", campaign_id: "9", campaign_name: "Reach", status: "ACTIVE", spend_usd: 1 }] }} days={30} canEdit refreshing={false} {...extra} />);
  expect(screen.getByText("Runs until you pause it")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Boost a post" }));
  expect(screen.getByRole("dialog").textContent).toBe("Boost Meta Ads");
  fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
  expect(api.meta).toHaveBeenCalledWith("new");
  fireEvent.click(screen.getByRole("tab", { name: "Ad sets" }));
  fireEvent.click(screen.getByRole("button", { name: "Create ad set" }));
  expect(api.meta).toHaveBeenLastCalledWith({ campaign_id: "9", create: "group" });
  fireEvent.click(screen.getByRole("tab", { name: "Ads" }));
  fireEvent.click(screen.getByRole("button", { name: "Create ad" }));
  expect(api.meta).toHaveBeenLastCalledWith({ campaign_id: "9", create: "ad" });
  cleanup();
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  expect(screen.queryByRole("note")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create ad group" }));
  expect(api.google).toHaveBeenLastCalledWith({ campaign_id: "11", create: "group" });
  cleanup();
  render(<PaidAnalytics kind="meta" payload={{ channels: [{ channel: "meta", connected: true, spend_usd: 0 }], connected: { meta: true }, campaigns: [] }} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad sets" }));
  expect((screen.getByRole("button", { name: "Create ad set" }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  render(<PaidAnalytics kind="youtube" payload={payload} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  expect(screen.getByRole("note").textContent).toBe("On Meta Ads, a new ad group is created together with a new campaign.");
  fireEvent.click(screen.getByRole("button", { name: "Create ad group" }));
  expect(api.google).toHaveBeenLastCalledWith("new", "youtube_ads");
  cleanup();
  render(<PaidAnalytics kind="meta" payload={payload} days={30} canEdit={false} refreshing={false} {...extra} />);
  expect(screen.queryByRole("button", { name: "Create campaign" })).toBeNull();
});
it("does not fetch drilldowns while Analytics is hidden", () => {
  render(<ChannelPageProvider value={{ active: "overview", tabs: ["overview", "analytics"], analytics: null }}><PaidAnalytics kind="google" payload={payload} days={30} canEdit refreshing={false} {...extra} /></ChannelPageProvider>);
  fireEvent.click(screen.getByRole("tab", { name: "Ads" }));
  expect(api.fetch).not.toHaveBeenCalled();
});

const pacing = { spend: 300, plan: 600, plan_basis: "founder" as const, pct: 100, capped_campaigns: 0, campaigns: 2, days_elapsed: 15, days_in_month: 30 };
it("keeps the USD monthly plan editor on the existing authorized route", async () => {
  api.plan.mockResolvedValue({ ok: true, json: async () => ({}) });
  const onChanged = vi.fn();
  render(<PaidAnalytics kind="google" payload={{ ...payload, currency: "USD", kpis: [...payload.kpis, { key: "pacing", value: 100, pacing }] }} days={30} canEdit refreshing={false} {...extra} onChanged={onChanged} />);
  expect(screen.getByTestId("monthly-plan").textContent).toContain("$300 of $600 this month");
  fireEvent.click(screen.getByRole("button", { name: /Edit plan/ }));
  fireEvent.change(screen.getByLabelText("Monthly plan in dollars"), { target: { value: "900" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(api.plan).toHaveBeenCalledWith("/api/channels/google_ads/monthly-budget", { method: "PUT", body: JSON.stringify({ usd: 900 }) });
  expect(api.fetch).not.toHaveBeenCalled();
});
it.each([{ currency: "USD", canEdit: false }, { currency: "INR", canEdit: true }, { currency: null, canEdit: true }])("does not offer the dollar-only editor without edit permission and known USD currency: %j", ({ currency, canEdit }) => {
  render(<PaidAnalytics kind="google" payload={{ ...payload, currency, kpis: [...payload.kpis, { key: "pacing", value: 100, pacing }] }} days={30} canEdit={canEdit} refreshing={false} {...extra} />);
  expect(screen.queryByRole("button", { name: /Edit plan/ })).toBeNull();
  expect(api.plan).not.toHaveBeenCalled();
});

it("pauses a running campaign in one click through the existing approval route and shows it paused", async () => {
  const onChanged = vi.fn();
  render(<PaidAnalytics kind="meta" payload={metaPayload("ACTIVE")} days={30} canEdit refreshing={false} channelName="Meta Ads" onChanged={onChanged} />);
  const toggle = screen.getByRole("switch", { name: "Pause Reach" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("button", { name: "Launch Reach" })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(api.metaOn).toHaveBeenCalledWith("9", "Reach", false);
  expect(api.wait).toHaveBeenCalledWith(change);
  expect(screen.getByRole("switch", { name: "Switch on Reach" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("status").textContent).toBe("Reach is paused.");
});
it("switching on asks first, and does nothing when declined", async () => {
  const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<PaidAnalytics kind="google" payload={{ ...payload, campaigns: [{ ...payload.campaigns[0], status: "PAUSED" }] }} days={30} canEdit refreshing={false} {...extra} />);
  fireEvent.click(screen.getByRole("switch", { name: "Switch on Search campaign" }));
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(api.googleOn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Launch Search campaign" }));
  await waitFor(() => expect(api.googleOn).toHaveBeenCalledWith("11", "Search campaign", true));
  await screen.findByRole("switch", { name: "Pause Search campaign" });
  ask.mockRestore();
});
it("a refused change says why and leaves the switch where it was", async () => {
  api.wait.mockResolvedValue({ state: "refused", message: "Zavi can't change Meta campaigns right now. Nothing was sent." });
  const onChanged = vi.fn();
  render(<PaidAnalytics kind="meta" payload={metaPayload("ACTIVE")} days={30} canEdit refreshing={false} channelName="Meta Ads" onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("switch", { name: "Pause Reach" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Nothing was sent.");
  expect(screen.getByRole("switch", { name: "Pause Reach" }).getAttribute("aria-checked")).toBe("true");
  expect(onChanged).not.toHaveBeenCalled();
});
it("members see the state but cannot switch, and read-only Google types stay locked", () => {
  const video = { ...payload.campaigns[1], id: "13", name: "Classic video", channel_type: "VIDEO" };
  render(<PaidAnalytics kind="google" payload={{ ...payload, campaigns: [payload.campaigns[0], video] }} days={30} canEdit refreshing={false} {...extra} />);
  expect((screen.getByRole("switch", { name: "Pause Classic video" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("switch", { name: "Pause Search campaign" }) as HTMLButtonElement).disabled).toBe(false);
  cleanup();
  render(<PaidAnalytics kind="google" payload={payload} days={30} canEdit={false} refreshing={false} {...extra} />);
  const locked = screen.getByRole("switch", { name: "Pause Search campaign" }) as HTMLButtonElement;
  expect(locked.disabled).toBe(true);
  expect(locked.getAttribute("aria-checked")).toBe("true");
});

const youtube = {
  platform: "youtube_ads", connected: true, error_code: null, currency: "USD", period: { from: "2026-10-01", to: "2026-10-30" },
  campaigns: [
    { id: "21", name: "Driver Pre-Roll", status: "ENABLED", channel_type: "DEMAND_GEN", goal: "Video views", spend: 338.2, conversions: 4, cpa: 84.55, conv_value: 0, views: 7840, view_rate: 35, cpv: 0.04, clicks: 186, impressions: 22400, daily_budget: 15 },
    { id: "22", name: "Rent vs Buy Awareness", status: "PAUSED", channel_type: "DEMAND_GEN", goal: "Video reach", spend: 0, conversions: 0, cpa: null, conv_value: 0, views: 0, view_rate: null, cpv: null, clicks: 0, impressions: 0, daily_budget: 10 },
    { id: "23", name: "Classic video", status: "ENABLED", channel_type: "VIDEO", goal: null, spend: 0, conversions: 0, cpa: null, conv_value: 0, views: 0, view_rate: null, cpv: null, clicks: 0, impressions: 5, daily_budget: 5 },
  ],
  totals: { campaigns: 3, spend: 338.2, conversions: 4, cpa: 84.55, conv_value: 0, roas: null, views: 7840, view_rate: 35, cpv: 0.04, impressions: 22400, clicks: 186 },
  daily_budget: { total_daily_budget_usd: 15, active_campaigns: 1 },
};
it("draws YouTube Ads on video numbers, with the same switch, Launch and Edit", async () => {
  const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PaidAnalytics kind="youtube" payload={youtube} days={30} canEdit refreshing={false} channelName="YouTube Ads" onChanged={() => undefined} />);
  const tile = (key: string) => document.querySelector(`[data-metric="${key}"]`)!.textContent;
  expect(tile("spend")).toContain("$338.20");
  expect(tile("view_rate")).toBe("View rate35.00%Of 22,400 impressions");
  expect(tile("conversions")).toContain("$84.55 per conversion");
  expect(tile("daily_budget")).toContain("Across 1 active campaign");
  const table = within(screen.getByRole("tabpanel", { name: "Campaign results" }));
  expect(table.getAllByRole("columnheader").map(h => h.textContent)).toEqual(["On", "Campaign", "Status", "Daily budget", "Views", "View rate", "Average cost per view", "Clicks", "Conversions", "Spend", "Actions"]);
  expect(table.getByText("Video views")).toBeTruthy();
  expect(table.getByText("Not launched yet")).toBeTruthy();
  expect(Array.from(document.querySelectorAll("tfoot td")).map(c => c.textContent)).toEqual(["", "3 campaigns", "", "$15 a day", "7,840", "35.00%", "$0.04", "186", "4", "$338.20", ""]);
  expect((screen.getByRole("switch", { name: "Pause Classic video" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Edit campaign for Driver Pre-Roll" }));
  expect(api.google).toHaveBeenCalledWith({ campaign_id: "21" }, "youtube_ads");
  fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
  expect(api.google).toHaveBeenCalledWith("new", "youtube_ads");
  fireEvent.click(screen.getByRole("button", { name: "Launch Rent vs Buy Awareness" }));
  await waitFor(() => expect(api.googleOn).toHaveBeenCalledWith("22", "Rent vs Buy Awareness", true));
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalled());
  expect(api.fetch.mock.calls[0][0]).toContain("/api/channels/youtube_ads/analytics/entities?campaign_id=21");
  ask.mockRestore();
});
it("an unread YouTube account shows no numbers", () => {
  const model = paidAnalyticsModel("youtube", { platform: "youtube_ads", connected: true, error_code: "google_ads_read_failed", campaigns: [], totals: null });
  expect(model.readable).toBe(false);
  expect(model.metrics.every(m => m.value === null)).toBe(true);
  expect(model.budget).toBeNull();
});

const tiktokPayload = {
  platform: "tiktok_ads", connected: true, error_code: null, window_days: 30, period: { from: "2026-10-01", to: "2026-10-30" },
  account: { name: "Upcar", advertiser_count: 1, campaign_count: 2, currency: "USD" },
  totals: { spend: 612.4, impressions: 48200, clicks: 412, conversions: 9, conv_value: 0, ctr: 0.85, cpa: 68.04, roas: 0, views: 21400 },
  daily_budget: { total_daily_budget_usd: 30, active_campaigns: 1 },
  campaigns: [
    { id: "71", advertiser_id: "900", currency: "USD", name: "Gig Drivers In-Feed", status: "ACTIVE", secondary_status: "CAMPAIGN_STATUS_ENABLE", objective: "TRAFFIC", daily_budget: 30, views: 21400, impressions: 48200, clicks: 412, spend: 612.4, conversions: 9, conv_value: 0, cpa: 68.04, url: null },
    { id: "72", advertiser_id: "900", currency: "USD", name: "Driver Stories", status: "PAUSED", objective: "VIDEO_VIEWS", daily_budget: 20, views: 0, impressions: 0, clicks: 0, spend: 0, conversions: 0, conv_value: 0, cpa: null, url: null },
  ],
};
it("draws TikTok Ads tiles and rows, and sends a switch for approval instead of changing TikTok", async () => {
  const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
  api.tiktokStatus.mockResolvedValue(undefined);
  render(<PaidAnalytics kind="tiktok" payload={tiktokPayload} days={30} canEdit refreshing={false} channelName="TikTok Ads" onChanged={() => undefined} />);
  expect(screen.getByTestId("value-views").textContent).toBe("21,400");
  expect(screen.getByTestId("value-cpm").textContent).toBe("$12.71");
  expect(screen.getByText("0.85% click-through rate")).toBeTruthy();
  expect(screen.getByText("$68.04 per conversion")).toBeTruthy();
  expect(screen.getByText("Across 1 active campaign")).toBeTruthy();
  expect(screen.getByText("Website visits")).toBeTruthy();
  expect(screen.getByText("Not launched yet")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Click-through rate" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit campaign for Driver Stories" }));
  expect(api.tiktokOpen).toHaveBeenCalledWith({ advertiser_id: "900", campaign_id: "72" });
  fireEvent.click(screen.getByRole("button", { name: /Create campaign/ }));
  expect(api.tiktokNew).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("switch", { name: "Pause Gig Drivers In-Feed" }));
  await waitFor(() => expect(api.tiktokStatus).toHaveBeenCalledWith({ advertiser_id: "900", campaign_id: "71" }, false));
  expect(await screen.findByText("Waiting for your approval")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Pause Gig Drivers In-Feed" }).getAttribute("aria-checked")).toBe("true");
  expect(api.metaOn).not.toHaveBeenCalled();
  expect(api.googleOn).not.toHaveBeenCalled();
  ask.mockRestore();
});
it("reads TikTok ad groups for the campaign's own ad account", async () => {
  render(<PaidAnalytics kind="tiktok" payload={tiktokPayload} days={30} canEdit={false} refreshing={false} channelName="TikTok Ads" onChanged={() => undefined} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledWith("/api/channels/tiktok_ads/analytics/entities?campaign_id=71&level=groups&since=2026-10-01&until=2026-10-30&advertiser_id=900"));
});

it("X Ads: tiles, the campaign table and Create campaign use the shared page, and an unread account still shows the table", async () => {
  const xPayload = {
    platform: "x_ads", connected: true, error_code: null, window_days: 30, period: { from: "2026-10-01", to: "2026-10-30" },
    account: { name: "Upcar", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" },
    totals: { spend: 148.6, impressions: 18600, clicks: 96, conversions: 3, ctr: 0.52, cpc: 1.55, cpa: 49.53 },
    engagements: 412, daily_budget: { total_daily_budget_usd: 10, active_campaigns: 1 }, conversions_unmeasured: null,
    campaigns: [{ id: "abc12", ad_account_id: "18ce5", currency: "USD", name: "Gig Drivers", status: "ACTIVE", spend: 148.6, clicks: 96, conversions: 3, cpa: 49.53, url: "https://ads.x.com/campaign_manager/18ce5/campaigns", daily_budget: 10, impressions: 18600, engagements: 412 }],
  };
  const opened = vi.fn();
  window.addEventListener("zavi:top-action-open", opened);
  render(<PaidAnalytics kind="x" payload={xPayload} days={30} canEdit refreshing={false} channelName="X Ads" onChanged={() => undefined} />);
  expect(screen.getByText("2.22% engagement rate")).toBeTruthy();
  expect(screen.getByRole("link", { name: /^Edit campaign for Gig Drivers/ }).getAttribute("href")).toBe("https://ads.x.com/campaign_manager/18ce5/campaigns");
  expect(screen.getByText("$7.99 per 1,000 impressions")).toBeTruthy();
  expect(screen.getAllByText("18,600").length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: "x_ads", key: "create_new_ad" });
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(1));
  expect(api.fetch.mock.calls[0][0]).toContain("/api/channels/x_ads/analytics/entities?campaign_id=abc12&level=groups");
  expect(api.fetch.mock.calls[0][0]).toContain("advertiser_id=18ce5");
  cleanup();
  window.removeEventListener("zavi:top-action-open", opened);
  render(<PaidAnalytics kind="x" payload={{ ...xPayload, error_code: "x_ads_read_failed", totals: null, campaigns: [] }} days={30} canEdit refreshing={false} channelName="X Ads" onChanged={() => undefined} />);
  expect(screen.getByRole("tab", { name: "Campaigns" })).toBeTruthy();
  expect(screen.getByText("Account results are unavailable. Try Refresh.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create campaign" })).toBeTruthy();
});

it("Reddit Ads: six tiles, the tabbed table, and its ad groups come from the Reddit route", async () => {
  const redditPayload = {
    platform: "reddit_ads", connected: true, error_code: null, window_days: 30, period: { from: "2026-10-01", to: "2026-10-30" },
    account: { name: "Upcar", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" },
    totals: { spend: 177, impressions: 15800, clicks: 142, conversions: 5, ctr: 0.9, cpc: 1.25, cpa: 35.4 },
    daily_budget: { total_daily_budget_usd: 10, active_campaigns: 1 },
    campaigns: [{ id: "c_1", ad_account_id: "a2_x", currency: "USD", name: "Driver Communities", status: "ACTIVE", spend: 177, clicks: 142, conversions: 5, cpa: 35.4, url: null, daily_budget: 10, impressions: 15800 }],
  };
  const opened = vi.fn();
  window.addEventListener("zavi:top-action-open", opened);
  render(<PaidAnalytics kind="reddit" payload={redditPayload} days={30} canEdit refreshing={false} channelName="Reddit Ads" onChanged={() => undefined} />);
  expect(document.querySelectorAll("[data-metric]")).toHaveLength(7);
  expect(screen.getByText("$11.20 per 1,000 impressions")).toBeTruthy();
  expect(screen.getAllByText("0.90%").length).toBeGreaterThan(1);
  expect(screen.getByText("Numbers as reported by Reddit Ads.", { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(1));
  expect(api.fetch.mock.calls[0][0]).toContain("/api/channels/reddit_ads/analytics/entities?campaign_id=c_1&level=groups");
  expect(api.fetch.mock.calls[0][0]).toContain("advertiser_id=a2_x");
  fireEvent.click(screen.getByRole("button", { name: "Create ad group" }));
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: "reddit_ads", key: "create_new_ad" });
  window.removeEventListener("zavi:top-action-open", opened);
});

it("X Ads: link clicks X did not report show as unknown, never as all clicks", () => {
  const base = { platform: "x_ads", connected: true, error_code: null, window_days: 30, period: { from: "2026-10-01", to: "2026-10-30" }, account: { name: "Upcar", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" }, engagements: 40, daily_budget: { total_daily_budget_usd: 10, active_campaigns: 1 }, conversions_unmeasured: null };
  render(<PaidAnalytics kind="x" payload={{ ...base, link_clicks_unmeasured: true, totals: { spend: 50, impressions: 4000, clicks: 77, conversions: 0, ctr: 1.9, cpc: 0.65, cpa: null }, campaigns: [{ id: "abc12", ad_account_id: "18ce5", currency: "USD", name: "Gig Drivers", status: "ACTIVE", spend: 50, clicks: 77, conversions: 0, cpa: null, url: null, daily_budget: 10, impressions: 4000, engagements: 40, link_clicks_unmeasured: true }] }} days={30} canEdit refreshing={false} channelName="X Ads" onChanged={() => undefined} />);
  expect(screen.getByTestId("value-clicks").textContent).toBe("—");
  expect(screen.getByText("X did not report link clicks for every campaign")).toBeTruthy();
  expect(document.body.textContent).not.toContain("77");
});

it("shows the budgets it could read when one active campaign has none", () => {
  const model = paidAnalyticsModel("meta", { ...metaPayload("ACTIVE"), meta_daily_budget: { total_daily_budget_usd: null, active_campaigns: 3, known_daily_budget_usd: 180, known_campaigns: 2 } });
  expect(model.budget).toBe(180);
  expect(model.budgetCounted).toBe(2);
  expect(model.activeCount).toBe(3);
  const full = paidAnalyticsModel("meta", { ...metaPayload("ACTIVE"), meta_daily_budget: { total_daily_budget_usd: 200, active_campaigns: 3, known_daily_budget_usd: 200, known_campaigns: 3 } });
  expect(full.budget).toBe(200);
  expect(full.budgetCounted).toBeNull();
});
