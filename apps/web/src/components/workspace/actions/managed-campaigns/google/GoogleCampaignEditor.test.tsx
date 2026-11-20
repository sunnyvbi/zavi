// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ campaignFetch: api, requestKey: (previous: { signature: string; id: string } | null, path: string, body: unknown) => { const signature = JSON.stringify([path, body]); return previous?.signature === signature ? previous : { signature, id: `key-${signature.length}` }; } }));
import { GoogleCampaignEditor } from "./GoogleCampaignEditor";
import { waitForGoogleChange } from "./googleEditorApi";

const view = {
  campaign: { id: "12000100", name: "Spring", status: "PAUSED", channel_type: "SEARCH", bidding_strategy_type: "MAXIMIZE_CONVERSIONS", daily_budget: 50, budget_shared: false, target_cpa: 20, target_roas: null, network: { search_network: false, content_network: false }, end_date: null },
  places: [{ id: "2840", name: "United States" }],
  places_editable: true,
  places_fingerprint: "a".repeat(64),
  ad_groups: [{ id: "12000300", name: "General", status: "ENABLED", type: "SEARCH_STANDARD", cpc_bid: null, keywords: [{ criterion_id: "555", text: "car rental", match_type: "PHRASE", status: "ENABLED" }] }],
  negative_keywords: [],
  ads: [],
  keywords_editable: true,
  currency: "USD",
  writes_enabled: true,
};
const calls = () => api.mock.calls.map(([p, o]) => [p, o?.method ?? "GET", o?.body ? JSON.parse(o.body) : null] as const);

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/channels/google_ads/campaigns/12000100" && !o?.method) return view;
    if (path.includes("/budget-edit/status/")) return { status: "acted" };
    if (path === "/api/agents/performance-marketer/budget-edit" || path === "/api/agents/performance-marketer/campaign-status") return { decision_id: "d-9" };
    if (path.startsWith("/api/approvals/")) return { ok: true };
    return { changes: [{ label: "Spring: name", decision_id: "d-1", approved: true, code: null }] };
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

it("a rename, a bid target, a removed keyword and a budget change: one editor Save, the budget through Ads Manager", async () => {
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Spring v2" } });
  fireEvent.change(screen.getByLabelText(/Target cost per conversion/), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: /car rental/ }));
  fireEvent.change(screen.getByLabelText(/daily budget/i), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls().some(([p]) => p.startsWith("/api/approvals/d-9/approve"))).toBe(true));
  expect(calls()).toEqual(
    expect.arrayContaining([
      ["/api/channels/google_ads/campaigns/12000100", "POST", { name: "Spring v2", target_cpa_usd: 25, remove_keywords: [{ ad_group_id: "12000300", criterion_id: "555" }] }],
      ["/api/agents/performance-marketer/budget-edit", "POST", { channel: "google", campaign_id: "12000100", campaign_name: "Spring", proposed_daily_budget_usd: 80 }],
    ]),
  );
});

it("Save stays off until something changed", async () => {
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Saved changes go to Google Ads right away; it stays paused/)).toBeTruthy();
});

it("uses editor validation so a hidden fractional bid target cannot block another change", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/channels/google_ads/campaigns/12000100" && !o?.method) {
      return { ...view, campaign: { ...view.campaign, bidding_strategy_type: "TARGET_ROAS", target_cpa: null, target_roas: 3.333 } };
    }
    return base(path, o);
  });
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  const name = await screen.findByLabelText("Campaign name");
  fireEvent.change(name, { target: { value: "Spring v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls()).toEqual(expect.arrayContaining([
    ["/api/channels/google_ads/campaigns/12000100", "POST", { name: "Spring v2" }],
  ])));
});

it("a paused campaign launches only after the confirm, through the on/off route", async () => {
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  expect(calls().some(([p]) => p.includes("campaign-status"))).toBe(false);
  expect(screen.getByText(/Starts spending up to \$50 a day/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Launch now" }));
  await waitFor(() =>
    expect(calls()).toEqual(expect.arrayContaining([["/api/agents/performance-marketer/campaign-status", "POST", { channel: "google", campaign_id: "12000100", campaign_name: "Spring", enabled: true }]])),
  );
});

it("a new campaign is not sent until every field is filled", () => {
  render(<GoogleCampaignEditor target="new" onClose={() => {}} onChanged={() => {}} />);
  expect((screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Name the campaign/)).toBeTruthy();
});

it("waitForGoogleChange: done, refused in plain words, or waiting in Approvals", async () => {
  const sleep = async () => {};
  api.mockResolvedValueOnce({ status: "acted" });
  expect(await waitForGoogleChange({ label: "x", decision_id: "d", approved: true, code: null }, 10_000, sleep)).toEqual({ state: "done" });
  api.mockResolvedValueOnce({ status: "rejected", dispatch_error: "cap_refuse: over" });
  expect(await waitForGoogleChange({ label: "x", decision_id: "d", approved: true, code: null }, 10_000, sleep)).toMatchObject({ state: "refused", message: expect.stringMatching(/Google daily limit/) });
  expect(await waitForGoogleChange({ label: "x", decision_id: "d", approved: false, code: "budget_choice_required" }, 10_000, sleep)).toMatchObject({ state: "waiting", message: expect.stringMatching(/Zavi ad budget/) });
});

it("YouTube: a classic Video campaign opens read-only, with nothing to save or launch", async () => {
  api.mockImplementation(async () => ({ ...view, campaign: { ...view.campaign, channel_type: "VIDEO" }, read_only: "video" }));
  render(<GoogleCampaignEditor channel="youtube_ads" target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByText(/can't change Video campaigns/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
  expect(calls()[0]![0]).toBe("/api/channels/youtube_ads/campaigns/12000100");
});

it("YouTube: the new-campaign form is the video form, and stays off until it is complete", async () => {
  render(<GoogleCampaignEditor channel="youtube_ads" target="new" onClose={() => {}} onChanged={() => {}} />);
  const create = screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/^YouTube videos/), { target: { value: "https://vimeo.com/1" } });
  expect(screen.getByLabelText(/^Long headlines/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Shorts push" } });
  fireEvent.change(screen.getByLabelText(/daily budget/i), { target: { value: "30" } });
  expect(screen.getAllByText(/Pick at least one place/).length).toBeGreaterThan(0);
  expect(create.disabled).toBe(true);
  expect(calls().some(([, m]) => m === "POST")).toBe(false);
});

it("a Save that went partly through shows what landed, follows it, and says what was not saved", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/channels/google_ads/campaigns/12000100" && o?.method === "POST") {
      throw Object.assign(new Error('Saved: "Spring: name" (on its way). Not saved: "General: add 1 keyword".'), {
        status: 502,
        body: { changes: [{ label: "Spring: name", decision_id: "d-1", approved: true, code: null }] },
      });
    }
    return base(path, o);
  });
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Spring v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const outcomes = await screen.findByTestId("google-editor-outcomes");
  expect(outcomes.textContent).toContain('Not saved: "General: add 1 keyword"');
  await waitFor(() => expect(screen.getByTestId("google-editor-outcomes").textContent).toMatch(/Spring: name: Done/), { timeout: 4000 });
});

it("Create ad group and Create ad: each goes to its own route under the campaign", async () => {
  const ad = () => {
    fireEvent.change(screen.getByLabelText("Landing page"), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText(/^Headlines/), { target: { value: "Rent a car\nFrom $35 a day\nBook today" } });
    fireEvent.change(screen.getByLabelText(/^Descriptions/), { target: { value: "Clean cars near you.\nLower fees than rentals." } });
  };
  const sent = { final_url: "https://example.com", headlines: ["Rent a car", "From $35 a day", "Book today"], descriptions: ["Clean cars near you.", "Lower fees than rentals."] };
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100", create: "group" }} onClose={() => {}} onChanged={() => {}} />);
  const group = (await screen.findByRole("button", { name: "Create paused ad group" })) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("Ad group name"), { target: { value: "General" } });
  fireEvent.change(screen.getByLabelText("Searches to show for"), { target: { value: "airport car rental" } });
  ad();
  expect(group.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Ad group name"), { target: { value: "Airport" } });
  fireEvent.click(group);
  await waitFor(() => expect(calls().some(([p]) => p === "/api/channels/google_ads/campaigns/12000100/ad-groups")).toBe(true));
  expect(calls().find(([p]) => p.endsWith("/ad-groups"))![2]).toEqual({ name: "Airport", keywords: [{ text: "airport car rental", match_type: "PHRASE" }], ...sent });
  cleanup();
  render(<GoogleCampaignEditor target={{ campaign_id: "12000100", create: "ad" }} onClose={() => {}} onChanged={() => {}} />);
  const create = await screen.findByRole("button", { name: "Create paused ad" });
  ad();
  fireEvent.click(create);
  await waitFor(() => expect(calls().some(([p]) => p === "/api/channels/google_ads/campaigns/12000100/ads")).toBe(true));
  expect(calls().find(([p]) => p.endsWith("/ads"))![2]).toEqual({ ad_group_id: "12000300", ...sent });
});
