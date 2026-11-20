// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ campaignFetch: api, requestKey: (previous: { signature: string; id: string } | null, path: string, body: unknown) => { const signature = JSON.stringify([path, body]); return previous?.signature === signature ? previous : { signature, id: `key-${signature.length}` }; } }));
import { MetaCampaignEditor } from "./MetaCampaignEditor";
import { waitForMetaChange } from "./metaEditorApi";

const view = {
  campaign: { id: "12000100", name: "Spring", status: "PAUSED", objective: "OUTCOME_TRAFFIC", budget_level: "campaign", daily_budget: 50, spend_cap: null },
  ad_sets: [{ id: "12000200", name: "US adults", status: "ACTIVE", daily_budget: null, end_time: null, places: [{ id: "country:US", name: "United States" }], places_editable: true, placements: null }],
  ads: [],
  currency: "USD",
  writes_enabled: true,
};
const calls = () => api.mock.calls.map(([p, o]) => [p, o?.method ?? "GET", o?.body ? JSON.parse(o.body) : null] as const);

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/channels/meta_ads/campaigns/12000100" && !o?.method) return view;
    if (path.includes("/budget-edit/status/")) return { status: "acted" };
    if (path === "/api/agents/performance-marketer/budget-edit" || path === "/api/agents/performance-marketer/campaign-status") return { decision_id: "d-9" };
    if (path.startsWith("/api/approvals/")) return { ok: true };
    return { changes: [{ label: "Spring: rename", decision_id: "d-1", approved: true, code: null }] };
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

it("a rename and a budget change: the rename to the editor route, the budget through Ads Manager then approved", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  const name = await screen.findByLabelText("Campaign name");
  fireEvent.change(name, { target: { value: "Spring v2" } });
  fireEvent.change(screen.getByLabelText(/daily budget/i), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls().some(([p]) => p.startsWith("/api/approvals/d-9/approve"))).toBe(true));
  expect(calls()).toEqual(
    expect.arrayContaining([
      ["/api/channels/meta_ads/campaigns/12000100", "POST", { name: "Spring v2" }],
      ["/api/agents/performance-marketer/budget-edit", "POST", { channel: "meta", campaign_id: "12000100", campaign_name: "Spring", proposed_daily_budget_usd: 80 }],
    ]),
  );
});

it("Save stays off until something changed", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Campaign name");
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Saved changes go to Meta right away; it stays paused/)).toBeTruthy();
});

it("keeps Meta's 200-character campaign-name contract", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  const name = await screen.findByLabelText("Campaign name");
  fireEvent.change(name, { target: { value: "x".repeat(200) } });
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("200/200")).toBeTruthy();
});

it("a paused campaign launches only after the confirm, through the on/off route", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  expect(calls().some(([p]) => p.includes("campaign-status"))).toBe(false);
  expect(screen.getByText(/Starts spending up to 50 USD a day/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Launch now" }));
  await waitFor(() =>
    expect(calls()).toEqual(expect.arrayContaining([["/api/agents/performance-marketer/campaign-status", "POST", { channel: "meta", campaign_id: "12000100", campaign_name: "Spring", enabled: true }]])),
  );
});

it("a new campaign is not sent until every field is filled", () => {
  render(<MetaCampaignEditor target="new" onClose={() => {}} onChanged={() => {}} />);
  expect((screen.getByRole("button", { name: "Build paused campaign" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Name the campaign/)).toBeTruthy();
});

it("waitForMetaChange: done, refused in plain words, or waiting in Approvals", async () => {
  const sleep = async () => {};
  api.mockResolvedValueOnce({ status: "acted" });
  expect(await waitForMetaChange({ label: "x", decision_id: "d", approved: true, code: null }, 10_000, sleep)).toEqual({ state: "done" });
  api.mockResolvedValueOnce({ status: "rejected", dispatch_error: "meta_ads_end_time_drift: changed" });
  expect(await waitForMetaChange({ label: "x", decision_id: "d", approved: true, code: null }, 10_000, sleep)).toMatchObject({ state: "refused", message: expect.stringMatching(/changed in Meta/) });
  expect(await waitForMetaChange({ label: "x", decision_id: "d", approved: false, code: "budget_choice_required" }, 10_000, sleep)).toMatchObject({ state: "waiting", message: expect.stringMatching(/Zavi ad budget/) });
});

it("a Save that went partly through shows what landed, follows it, and says what was not saved", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/channels/meta_ads/campaigns/12000100" && o?.method === "POST") {
      throw Object.assign(new Error('Saved: "Spring: rename" (on its way). Not saved: "US adults: end date".'), {
        status: 502,
        body: { changes: [{ label: "Spring: rename", decision_id: "d-1", approved: true, code: null }] },
      });
    }
    return base(path, o);
  });
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Spring v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const outcomes = await screen.findByTestId("meta-editor-outcomes");
  expect(outcomes.textContent).toContain('Not saved: "US adults: end date"');
  await waitFor(() => expect(screen.getByTestId("meta-editor-outcomes").textContent).toContain("Spring: rename: Done in Meta."), { timeout: 4000 });
});

it("a Save with a budget change sends the budget first, so its refusal stops the Save before the other changes", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path === "/api/agents/performance-marketer/budget-edit") throw Object.assign(new Error("Over your Meta daily limit. Nothing changed."), { status: 409 });
    return base(path, o);
  });
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Spring v2" } });
  fireEvent.change(screen.getByLabelText(/daily budget/i), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.getByTestId("meta-editor-outcomes").textContent).toContain("Over your Meta daily limit"));
  expect(calls().some(([p, m]) => p === "/api/channels/meta_ads/campaigns/12000100" && m === "POST")).toBe(false);
});

it("an approve whose reply was lost is followed when the row moved on", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path.startsWith("/api/approvals/")) throw Object.assign(new Error("network"), { status: 502 });
    return base(path, o);
  });
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText(/daily budget/i), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.getByTestId("meta-editor-outcomes").textContent).toContain("Spring: daily budget: Done in Meta."), { timeout: 4000 });
});

it("an approved change whose dispatch could not be started says so, with no dead Approvals link", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: { method?: string }) => {
    if (path.startsWith("/api/approvals/")) throw Object.assign(new Error("network"), { status: 502 });
    if (path.includes("/budget-edit/status/")) return { status: "approved" };
    return base(path, o);
  });
  render(<MetaCampaignEditor target={{ campaign_id: "12000100" }} onClose={() => {}} onChanged={() => {}} />);
  fireEvent.change(await screen.findByLabelText(/daily budget/i), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.getByTestId("meta-editor-outcomes").textContent).toContain("Approved, but Zavi could not start it yet"));
  expect(screen.queryByRole("link", { name: "Open Approvals" })).toBeNull();
});

it("Create ad: the ad goes to the campaign's ads route with the picked ad set", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100", create: "ad" }} onClose={() => {}} onChanged={() => {}} />);
  const create = (await screen.findByRole("button", { name: "Create ad" })) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Ad name"), { target: { value: "Spring ad" } });
  fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Rent a car" } });
  fireEvent.change(screen.getByLabelText("Ad text"), { target: { value: "From $35 a day" } });
  fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://example.com" } });
  fireEvent.change(screen.getByLabelText(/^Image link/), { target: { value: "https://example.com/a.jpg" } });
  expect(screen.getByTestId("create-preview-ad").textContent).toContain("Rent a car");
  fireEvent.click(create);
  await waitFor(() => expect(calls().some(([p, m]) => p === "/api/channels/meta_ads/campaigns/12000100/ads" && m === "POST")).toBe(true));
  expect(calls().find(([p]) => p.endsWith("/ads"))![2]).toEqual({ ad_set_id: "12000200", name: "Spring ad", headline: "Rent a car", primary_text: "From $35 a day", link_url: "https://example.com", image_url: "https://example.com/a.jpg", cta: "LEARN_MORE" });
  expect(api.mock.calls.find(([p]) => String(p).endsWith("/ads"))![1].headers["Idempotency-Key"]).toMatch(/^key-\d+$/);
});

it("Create ad set: a campaign that holds the budget says why and sends nothing", async () => {
  render(<MetaCampaignEditor target={{ campaign_id: "12000100", create: "group" }} onClose={() => {}} onChanged={() => {}} />);
  expect((await screen.findByRole("status")).textContent).toMatch(/holds the budget for all its ad sets/);
  expect((screen.getByRole("button", { name: "Create paused ad set" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls().some(([, m]) => m === "POST")).toBe(false);
});
