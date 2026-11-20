// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => vi.fn());
vi.mock("../managed-campaigns/api", async importOriginal => ({ ...await importOriginal<typeof import("../managed-campaigns/api")>(), campaignFetch: api }));
vi.mock("../topActions/fields", () => ({
  PlacesField: ({ value, onChange, disabled }: { disabled?: boolean; value: Array<{ id: string; name: string }>; onChange: (v: Array<{ id: string; name: string }>) => void }) => <button type="button" disabled={disabled} onClick={() => onChange([{ id: "456", name: "New place" }])}>Places: {value.map(p => p.id).join(",")}</button>,
  VideoField: ({ onChange }: { onChange: (v: string) => void }) => <button type="button" onClick={() => onChange("upload:tenant/video.mp4")}>Choose uploaded video</button>,
}));
import { TiktokCampaignEditor } from "./TiktokCampaignEditor";
import { NewTiktokCampaign } from "./NewTiktokCampaign";
import { settingsDiff } from "./types";
import { validVideoSource } from "./VideoUrlField";
import { TopActionsRow } from "../topActions/TopActionsRow";
import { tiktok_ads } from "../platforms/tiktok_ads";
import { openTiktokCampaign } from "./openCampaign";

const advertiser = { id: "11", name: "Test advertiser", currency: "USD", timezone: "UTC" };
const options = { advertiser, identities: [{ identity_id: "identity-1", display_name: "Business account" }], videos: [{ video_id: "v1", name: "Existing video" }, { video_id: "v2", name: "New library video" }], zavi_videos: [], locations: [{ location_id: "123", name: "United States" }], languages: [{ id: "en", name: "English" }], blockers: [], end_date_enabled: true };
const detail = {
  advertiser,
  campaign: { id: "101", level: "campaign", campaign_id: "101", ad_group_id: null, name: "Traffic campaign", status: "ACTIVE", budget: null, budget_mode: "BUDGET_MODE_INFINITE", revision: "campaign-revision", settings: { campaign_name: "Traffic campaign", objective_type: "TRAFFIC" } },
  ad_groups: [{ id: "202", level: "ad_group", campaign_id: "101", ad_group_id: "202", name: "Adult audience", status: "ACTIVE", budget: 30, budget_mode: "BUDGET_MODE_DAY", revision: "group-revision", settings: { adgroup_name: "Adult audience", location_ids: ["123"], age_groups: ["AGE_18_24"], gender: "GENDER_UNLIMITED", languages: [], schedule_start_time: "2026-12-01T00:00:00Z", schedule_end_time: "2026-12-10T00:00:00Z" } }],
  ads: [{ id: "303", level: "ad", campaign_id: "101", ad_group_id: "202", name: "Video ad", status: "ACTIVE", budget: null, budget_mode: null, revision: "ad-revision", settings: { ad_name: "Video ad", ad_text: "Original ad", landing_page_url: "https://example.com", call_to_action: "LEARN_MORE", video_id: "v1" } }],
};
const posts = () => api.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  api.mockReset(); api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "action-1", video_id: "prepared-video" } : path.includes("campaign-options") ? options : detail);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
const open = () => render(<TiktokCampaignEditor target={{ advertiser_id: "11", campaign_id: "101" }} onClose={() => {}} onChanged={() => {}} />);
async function select(value: string) { await screen.findByLabelText("Campaign, ad group or ad"); fireEvent.change(screen.getByLabelText("Campaign, ad group or ad"), { target: { value } }); }

it("opens the exact advertiser and submits only the changed campaign setting with its revision", async () => {
  open(); await screen.findByLabelText("Name");
  expect(api).toHaveBeenCalledWith("/api/channels/tiktok_ads/campaigns/101?advertiser_id=11");
  expect((screen.getByRole("button", { name: "Review settings changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ advertiser_id: "11", campaign_id: "101", object_id: "101", level: "campaign", revision: "campaign-revision", changes: { campaign_name: "Renamed" } });
  expect(posts()).toHaveLength(1);
  expect(posts()[0][1].headers["Idempotency-Key"]).toBe(JSON.parse(posts()[0][1].body).request_id);
});
it("preserves unsaved targeting until explicitly discarded before editing the ad group budget", async () => {
  open(); await select("ad_group:202");
  fireEvent.click(screen.getByRole("button", { name: "Places: 123" }));
  expect((screen.getByRole("button", { name: "Review budget change" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Review pause" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Review budget change" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ object_id: "202", level: "ad_group", revision: "group-revision", changes: { daily_budget_usd: 45 } });
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ daily_budget_usd: 45 });
});
it("keeps existing targeting and sends only a changed schedule as UTC", async () => {
  open(); await select("ad_group:202");
  fireEvent.change(screen.getByLabelText("End time (UTC)"), { target: { value: "2026-12-08T13:00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ schedule_end_time: "2026-12-08T13:00:00.000Z" });
});
it("edits ad creative and selects a video already in the advertiser library", async () => {
  open(); await select("ad:303");
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Updated ad" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ level: "ad", object_id: "303", revision: "ad-revision", changes: { ad_text: "Updated ad", video_id: "v2" } });
});
it("prepares an uploaded replacement before proposing it, and preserves the current video until preparation succeeds", async () => {
  open(); await select("ad:303");
  fireEvent.click(screen.getByRole("button", { name: "Choose uploaded video" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare selected video" }));
  await waitFor(() => expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).value).toBe("prepared-video"));
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ advertiser_id: "11", video_upload_path: "tenant/video.mp4" });
  expect(posts()[0][1].headers["Idempotency-Key"]).toBe(JSON.parse(posts()[0][1].body).request_id);
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[1][1].body).changes).toEqual({ video_id: "prepared-video" });
});
it("preserves changes and the request key after a failed save, without retrying automatically", async () => {
  open(); await screen.findByLabelText("Name");
  api.mockRejectedValueOnce(new Error("Campaign changed since you opened it. Refresh."));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rename" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByRole("alert");
  expect(posts()).toHaveLength(1);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Rename");
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).request_id).toBe(JSON.parse(posts()[1][1].body).request_id);
});
it("creates a deterministic campaign proposal from the user's exact settings", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Launch" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Shop our spring collection" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com/spring" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose uploaded video" }));
  fireEvent.click(screen.getByRole("button", { name: "Create campaign proposal" }));
  await screen.findByText("Your campaign proposal is ready.");
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toBe("/api/channels/tiktok_ads/campaigns");
  expect(posts()[0][1].headers["Idempotency-Key"]).toBe(JSON.parse(posts()[0][1].body).request_id);
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ campaign_type: "TRAFFIC", name: "Launch", daily_budget_usd: 30, identity_id: "identity-1", location_ids: ["123"], ad_text: "Shop our spring collection", landing_url: "https://example.com/spring", video_upload_path: "tenant/video.mp4" });
});
it("does not rewrite settings absent from the live response", () => {
  expect(settingsDiff({ ad_text: "Old" }, { ad_text: "New" })).toEqual({ ad_text: "New" });
  expect(settingsDiff({}, { schedule_end_time: undefined })).toEqual({});
});

it("opens the new campaign form and row editor from the channel's controls", async () => {
  render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "New campaign" }));
  await screen.findByLabelText("Campaign name");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => openTiktokCampaign({ advertiser_id: "11", campaign_id: "101" }));
  await screen.findByLabelText("Campaign, ad group or ad");
  expect(posts()).toHaveLength(0);
});

it("does not submit a budget at TikTok's floor or with fractional cents", async () => {
  open(); await select("ad_group:202");
  for (const amount of ["20", "30.001"]) {
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: amount } });
    expect((screen.getByRole("button", { name: "Review budget change" }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(posts()).toHaveLength(0);
});

it("disables creative edits the provider does not support while allowing an ad name change", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, ads: [{ ...detail.ads[0], editable_fields: ["ad_name"], limitations: ["Edit the original source post in TikTok Ads Manager."] }] });
  open(); await select("ad:303");
  expect((screen.getByLabelText(/Ad text/) as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Prepare selected video" })).toBeNull();
});

it("disables a portfolio's CTA independently while keeping text, destination and video editable", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, ads: [{ ...detail.ads[0], editable_fields: ["ad_name", "ad_text", "landing_page_url", "video_id"] }] });
  open(); await select("ad:303");
  expect((screen.getByLabelText("Call to action") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText(/Ad text/) as HTMLTextAreaElement).disabled).toBe(false);
  expect((screen.getByLabelText("Landing page") as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).disabled).toBe(false);
});

it("shows a non-USD budget in its account currency and explains why budget editing is unavailable", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, advertiser: { ...advertiser, currency: "EUR" } });
  open(); await select("ad_group:202");
  expect((screen.getByLabelText("Daily budget (EUR)") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Current: EUR 30.00 a day/).textContent).toContain("Budget changes in Zavi are available only for USD accounts.");
  expect((screen.getByRole("button", { name: "Review budget change" }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([{ ages: ["AGE_13_17", "AGE_18_24"], notice: /Current ages: 13–17/ }, { ages: [], notice: /Current targeting has no age restrictions/ }])("accurately displays current ages $ages and requires deliberate adult replacement", async ({ ages, notice }) => {
  const group = detail.ad_groups[0];
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "action-1" } : path.includes("campaign-options") ? options : { ...detail, ad_groups: [{ ...group, settings: { ...group.settings, age_groups: ages } }] });
  open(); await select("ad_group:202");
  expect(screen.getByText(notice)).toBeTruthy();
  expect(screen.queryByText("Leave all unchecked to reach all adults (18+).")).toBeNull();
  expect((screen.getByLabelText("18–24") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Replace with adult targeting (18+)" }));
  expect((screen.getByLabelText("18–24") as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ age_groups: ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"] });
});

it("preserves unsupported current ages when only the name changes", async () => {
  const group = detail.ad_groups[0];
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "action-1" } : path.includes("campaign-options") ? options : { ...detail, ad_groups: [{ ...group, settings: { ...group.settings, age_groups: ["AGE_13_17", "AGE_18_24"] } }] });
  open(); await select("ad_group:202");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed group" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ adgroup_name: "Renamed group" });
});

it.each(["settings", "budget", "video"])("requires explicit discard before switching away from an unsaved %s draft", async kind => {
  open(); await select(kind === "video" ? "ad:303" : "ad_group:202");
  if (kind === "settings") fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft group" } });
  if (kind === "budget") fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: "45" } });
  if (kind === "video") fireEvent.click(screen.getByRole("button", { name: "Choose uploaded video" }));
  const selector = screen.getByLabelText("Campaign, ad group or ad") as HTMLSelectElement;
  expect(selector.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Review pause" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/before switching to another campaign/)).toBeTruthy();
  fireEvent.change(selector, { target: { value: "campaign:101" } });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(kind === "settings" ? "Draft group" : kind === "budget" ? "Adult audience" : "Video ad");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(selector.disabled).toBe(false);
  fireEvent.change(selector, { target: { value: "campaign:101" } });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Traffic campaign");
  expect(posts()).toHaveLength(0);
});

it("respects each audience capability independently", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, ad_groups: [{ ...detail.ad_groups[0], editable_fields: ["adgroup_name", "location_ids", "age_groups", "gender"] }] });
  open(); await select("ad_group:202");
  expect((screen.getByRole("button", { name: "Places: 123" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByLabelText("18–24") as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByLabelText("Gender") as HTMLSelectElement).disabled).toBe(false);
  expect((screen.getByLabelText("Languages") as HTMLSelectElement).disabled).toBe(true);
});

it("creates a campaign using an existing library video without uploading it again", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Library launch" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Our new collection" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com/new" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Create campaign proposal" }));
  await screen.findByText("Your campaign proposal is ready.");
  const body = JSON.parse(posts()[0][1].body);
  expect(body.video_id).toBe("v2");
  expect(body.video_upload_path).toBeUndefined();
  expect(body.video_artifact_id).toBeUndefined();
  expect(posts()).toHaveLength(1);
});

it("loads more library pages and preserves a selected video while searching loaded results", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? { ...options, videos_next_page: 2 } : path.includes("campaign-videos?") ? { videos: [{ video_id: "v3", name: "Summer video" }], page: 2, next_page: null, truncated: false } : detail);
  open(); await select("ad:303");
  fireEvent.click(screen.getByRole("button", { name: "Load more videos" }));
  await screen.findByRole("option", { name: "Summer video · v3" });
  expect(api).toHaveBeenCalledWith("/api/channels/tiktok_ads/campaign-videos?advertiser_id=11&page=2");
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v3" } });
  fireEvent.change(screen.getByLabelText("Search loaded videos"), { target: { value: "Existing" } });
  expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).value).toBe("v3");
  expect(screen.getByRole("option", { name: "Summer video · v3" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more videos" })).toBeNull();
});

it("retries choice loading without replacing unsaved settings", async () => {
  let attempts = 0;
  api.mockImplementation(async (path: string) => {
    if (path.includes("campaign-options")) { if (++attempts === 1) throw new Error("Unavailable"); return options; }
    return detail;
  });
  open(); await screen.findByRole("button", { name: "Retry loading choices" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Preserve this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry loading choices" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry loading choices" })).toBeNull());
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Preserve this draft");
});

it("explicitly discards a stale draft and reads the latest settings", async () => {
  open(); await screen.findByLabelText("Name");
  api.mockRejectedValueOnce(new Error("Campaign changed. Refresh."));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Stale draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes and reload current settings" }));
  await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Traffic campaign"));
  expect((screen.getByLabelText("Campaign, ad group or ad") as HTMLSelectElement).disabled).toBe(false);
});

it("shows parent IDs, advertiser timezone and existing configuration", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, advertiser: { ...advertiser, timezone: "Asia/Kolkata" }, ad_groups: [{ ...detail.ad_groups[0], settings: { ...detail.ad_groups[0].settings, placements: ["PLACEMENT_TIKTOK"], optimization_goal: "CLICK", promotion_type: "WEBSITE" } }] });
  open(); await select("ad_group:202");
  expect(screen.getByRole("option", { name: /Ad · Video ad · ID 303 · Ad group: Adult audience \(202\)/ })).toBeTruthy();
  expect(screen.getAllByText(/Account time zone: Asia\/Kolkata/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("Current configuration"));
  expect(screen.getByText("Optimization goal")).toBeTruthy();
  expect(screen.getByText("Click")).toBeTruthy();
});

it("submits only selected advanced targeting and interaction changes", async () => {
  const group = detail.ad_groups[0];
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "a1" } : path.includes("campaign-options") ? { ...options, audiences: [{ id: "777", name: "Site visitors" }], interests: [{ id: "888", name: "Travel" }] } : { ...detail, ad_groups: [{ ...group, editable_fields: ["adgroup_name", "audience_ids", "interest_category_ids", "comment_disabled"], settings: { ...group.settings, comment_disabled: false } }] });
  open(); await select("ad_group:202");
  fireEvent.click(screen.getByText("Advanced audience and delivery"));
  fireEvent.change(screen.getByLabelText("Included audiences"), { target: { value: "777" } });
  fireEvent.change(screen.getByLabelText("Interests"), { target: { value: "888" } });
  fireEvent.change(screen.getByLabelText("Disable comments"), { target: { value: "true" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ audience_ids: ["777"], interest_category_ids: ["888"], comment_disabled: true });
});

it.each(["campaign:101", "ad:303"])("proposes resume for a paused %s using backend budget ownership validation", async target => {
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "a1" } : path.includes("campaign-options") ? options : { ...detail, campaign: { ...detail.campaign, status: "PAUSED" }, ads: [{ ...detail.ads[0], status: "PAUSED" }] });
  open(); await select(target);
  fireEvent.click(screen.getByRole("button", { name: "Review resume" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ status: "ACTIVE" });
});

it("creates a campaign with explicit advanced selections and an account-timezone delivery mask", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Advanced launch" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Shop the collection" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com/new" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  fireEvent.click(screen.getByText("Advanced audience and delivery"));
  fireEvent.click(screen.getByLabelText("IOS"));
  fireEvent.change(screen.getByLabelText("Disable comments"), { target: { value: "true" } });
  fireEvent.click(screen.getByRole("button", { name: "Use weekdays, 09:00–17:00" }));
  fireEvent.click(screen.getByRole("button", { name: "Create campaign proposal" }));
  await screen.findByText("Your campaign proposal is ready.");
  const body = JSON.parse(posts()[0][1].body);
  expect(body).toMatchObject({ operating_systems: ["IOS"], comment_disabled: true });
  expect(body.dayparting).toHaveLength(336);
  expect(body.dayparting.slice(0, 48)).toBe("0".repeat(18) + "1".repeat(16) + "0".repeat(14));
  expect(body.dayparting.slice(240)).toBe("0".repeat(96));
  expect(body.share_disabled).toBeUndefined();
});

it("requires a positive custom bid and explains conflicting smart audience/language selections", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Bid test" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Our collection" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v1" } });
  expect((screen.getByRole("button", { name: "Create campaign proposal" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByText("Advanced audience and delivery"));
  fireEvent.change(screen.getByLabelText("Bid strategy"), { target: { value: "BID_TYPE_CUSTOM" } });
  expect((screen.getByRole("button", { name: "Create campaign proposal" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Bid per click (USD)"), { target: { value: "0.50" } });
  expect((screen.getByRole("button", { name: "Create campaign proposal" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Languages"), { target: { value: "en" } });
  fireEvent.change(screen.getByLabelText("Smart audience expansion"), { target: { value: "true" } });
  expect(screen.getByText(/Zavi currently supports Smart audience expansion with all languages/)).toBeTruthy();
});

it("does not retain an unsaved custom bid when switching back to maximum results", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Maximum results" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Shop today" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v1" } });
  fireEvent.click(screen.getByText("Advanced audience and delivery"));
  fireEvent.change(screen.getByLabelText("Bid strategy"), { target: { value: "BID_TYPE_CUSTOM" } });
  fireEvent.change(screen.getByLabelText("Bid per click (USD)"), { target: { value: "0.50" } });
  fireEvent.change(screen.getByLabelText("Bid strategy"), { target: { value: "BID_TYPE_NO_BID" } });
  fireEvent.click(screen.getByRole("button", { name: "Create campaign proposal" }));
  await screen.findByText("Your campaign proposal is ready.");
  expect(JSON.parse(posts()[0][1].body).bid_type).toBe("BID_TYPE_NO_BID");
  expect(JSON.parse(posts()[0][1].body).bid_price).toBeUndefined();
});

it("creates from a public HTTPS video URL, submitting only the chosen source", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "URL launch" } });
  fireEvent.change(screen.getByLabelText(/Ad text/), { target: { value: "Our new collection" } });
  fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  fireEvent.change(screen.getByLabelText("Public HTTPS video URL"), { target: { value: "http://cdn.example.com/ad.mp4" } });
  expect((screen.getByRole("button", { name: "Create campaign proposal" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Public HTTPS video URL"), { target: { value: "https://cdn.example.com/ad.mp4" } });
  expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Create campaign proposal" }));
  await screen.findByText("Your campaign proposal is ready.");
  const body = JSON.parse(posts()[0][1].body);
  expect(body.video_url).toBe("https://cdn.example.com/ad.mp4");
  expect(body.video_id).toBeUndefined();
  expect(body.video_upload_path).toBeUndefined();
  expect(body.video_artifact_id).toBeUndefined();
});

it("clears the pending URL when a different library video is chosen", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  fireEvent.change(screen.getByLabelText("Public HTTPS video URL"), { target: { value: "https://cdn.example.com/ad.mp4" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v1" } });
  expect((screen.getByLabelText("Public HTTPS video URL") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).value).toBe("v1");
});

it("prepares a public HTTPS URL for creative replacement before proposing the returned video ID", async () => {
  open(); await select("ad:303");
  fireEvent.click(screen.getByText("Upload or choose a new video"));
  fireEvent.change(screen.getByLabelText("Public HTTPS video URL"), { target: { value: "http://cdn.example.com/ad.mp4" } });
  expect((screen.getByRole("button", { name: "Prepare selected video" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Public HTTPS video URL"), { target: { value: "https://cdn.example.com/ad.mp4" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare selected video" }));
  await waitFor(() => expect((screen.getByLabelText("Video in this ad account") as HTMLSelectElement).value).toBe("prepared-video"));
  const body = JSON.parse(posts()[0][1].body);
  expect(body).toMatchObject({ advertiser_id: "11", video_url: "https://cdn.example.com/ad.mp4" });
  expect(body.video_upload_path).toBeUndefined();
  expect(body.video_id).toBeUndefined();
  expect(posts()[0][0]).toBe("/api/channels/tiktok_ads/campaign-videos");
  expect(posts()[0][1].headers["Idempotency-Key"]).toBe(body.request_id);
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[1][1].body).changes).toEqual({ video_id: "prepared-video" });
});

it("labels dynamic daily budgets as averages with daily and weekly spending context", async () => {
  api.mockImplementation(async (path: string) => path.includes("campaign-options") ? options : { ...detail, ad_groups: [{ ...detail.ad_groups[0], budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" }] });
  open(); await select("ad_group:202");
  expect((screen.getByLabelText("Average daily budget (USD)") as HTMLInputElement).value).toBe("30");
  expect(screen.getByText(/a day on average/)).toBeTruthy();
  expect(screen.getByText(/up to 25% more on a day/).textContent).toContain("7× the average daily budget");
  expect(screen.getByText(/up to 25% more on a day/).textContent).toContain("Changing the budget during the week adjusts this allowance.");
});

it("accepts only complete HTTPS URL sources without embedded credentials", () => {
  expect(validVideoSource("url:https://cdn.example.com/ad.mp4")).toBe(true);
  for (const source of ["", "url:http://cdn.example.com/ad.mp4", "url:https:example.com/ad.mp4", "url:https://example.com/video with spaces.mp4", "url:https://test-user:test-value@example.com/ad.mp4"]) expect(validVideoSource(source)).toBe(false);
});

const disclosureAd = { ...detail.ads[0], editable_fields: ["ad_name", "ad_text", "landing_page_url", "call_to_action", "video_id", "aigc_disclosure_type"], settings: { ...detail.ads[0].settings, identity_type: "CUSTOMIZED_USER", ad_format: "SINGLE_VIDEO", aigc_disclosure_type: "SELF_DISCLOSURE" } };
function eligibleDisclosureFixture(generated: true | null = null) {
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "a1", video_id: "prepared-video", ai_generated: generated } : path.includes("campaign-options") ? options : { ...detail, ads: [disclosureAd] });
}
it("requires a fresh disclosure for an eligible replacement and sends it even when the current label is the same", async () => {
  eligibleDisclosureFixture(); open(); await select("ad:303");
  expect(screen.queryByLabelText("AI-generated content disclosure")).toBeNull();
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  expect((screen.getByLabelText("AI-generated content disclosure") as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Review settings changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("AI-generated content disclosure"), { target: { value: "SELF_DISCLOSURE" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ video_id: "v2", aigc_disclosure_type: "SELF_DISCLOSURE" });
});
it("resets disclosure whenever a different replacement is selected and omits it when returning to the original video", async () => {
  eligibleDisclosureFixture(); open(); await select("ad:303");
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  fireEvent.change(screen.getByLabelText("AI-generated content disclosure"), { target: { value: "NOT_DECLARED" } });
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v1" } });
  expect(screen.queryByLabelText("AI-generated content disclosure")).toBeNull();
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v2" } });
  expect((screen.getByLabelText("AI-generated content disclosure") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Video in this ad account"), { target: { value: "v1" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rename only" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ ad_name: "Rename only" });
});
it("requires explicit generated-content confirmation and hides the no-label choice for known generated media", async () => {
  eligibleDisclosureFixture(true); open(); await select("ad:303");
  fireEvent.click(screen.getByRole("button", { name: "Choose uploaded video" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare selected video" }));
  await screen.findByText(/This video was generated in Zavi/);
  expect((screen.getByRole("button", { name: "Review settings changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("option", { name: "Do not add the AI-generated content label" })).toBeNull();
  fireEvent.change(screen.getByLabelText("AI-generated content disclosure"), { target: { value: "SELF_DISCLOSURE" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[1][1].body).changes).toEqual({ video_id: "prepared-video", aigc_disclosure_type: "SELF_DISCLOSURE" });
});
it("keeps UTC end-time editing available when the start time is no longer editable", async () => {
  const group = detail.ad_groups[0];
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "a1" } : path.includes("campaign-options") ? options : { ...detail, advertiser: { ...advertiser, timezone: "Asia/Kolkata" }, ad_groups: [{ ...group, editable_fields: ["adgroup_name", "schedule_end_time"] }] });
  open(); await select("ad_group:202");
  expect((screen.getByLabelText("Start time (UTC)") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("End time (UTC)") as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("End time (UTC)"), { target: { value: "2026-12-08T13:00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ schedule_end_time: "2026-12-08T13:00:00.000Z" });
});
it("replaces the operating system choice instead of submitting multiple systems", async () => {
  const group = detail.ad_groups[0];
  api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "POST" ? { action_id: "a1" } : path.includes("campaign-options") ? options : { ...detail, ad_groups: [{ ...group, editable_fields: ["adgroup_name", "operating_systems"], settings: { ...group.settings, operating_systems: ["IOS"] } }] });
  open(); await select("ad_group:202"); fireEvent.click(screen.getByText("Advanced audience and delivery"));
  fireEvent.click(screen.getByLabelText("ANDROID"));
  expect((screen.getByLabelText("IOS") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Review settings changes" }));
  await screen.findByText("Proposal ready for review.");
  expect(JSON.parse(posts()[0][1].body).changes).toEqual({ operating_systems: ["ANDROID"] });
});

it("shows the dynamic average daily budget used for new Traffic campaigns", async () => {
  render(<NewTiktokCampaign onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Average daily budget (USD)");
  expect((screen.getByLabelText("Average daily budget (USD)") as HTMLInputElement).value).toBe("30");
  expect(screen.getByText(/up to 25% more on a day/).textContent).toContain("7× the average daily budget");
});
