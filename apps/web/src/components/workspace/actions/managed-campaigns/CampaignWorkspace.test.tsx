// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api, requestKey: (_old: unknown, _path: string, body: unknown) => ({ signature: JSON.stringify(body), id: "11111111-1111-4111-8111-111111111111" }) }));
import { chatgpt_ads } from "../platforms/chatgpt_ads";
import { CampaignWorkspace } from "./CampaignWorkspace";
import { ChannelBalance } from "./ChannelBalance";
import { openNewCampaign } from "./newCampaignRequest";
const campaign = { id: "c1", name: "zv-acme--Launch", status: "paused", updated_at: 10, budget: { lifetime_spend_limit_micros: 100000000 }, clicks: 12, spend: 4 };
const payload = { source: "chatgpt_ads_api", currency: "USD", campaign_name_prefix: "zv-acme--", campaigns: [campaign], totals_across_your_campaigns_only: { clicks: 12, spend: 4 } };
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string) => path.endsWith("/wallet") ? { balance_cents: 10000, reserved_cents: 0, funding_enabled: true, auto_refill_enabled: false } : path.endsWith("/resources") ? { conversion_events: [], inclusion_audiences: [], exclusion_audiences: [], product_feeds: [], warnings: [] } : { rows: [] });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); });
async function confirmActivate() {
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Activate" }) as HTMLButtonElement;
  await waitFor(() => expect(go.disabled).toBe(false));
  fireEvent.click(go);
}
it("switches campaigns with the current revision and refreshes only after success", async () => {
  const refresh = vi.fn(); render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={14} loading={false} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole("switch", { name: "Activate Launch" }));
  await confirmActivate();
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  const call = api.mock.calls.find(([p]) => p.endsWith("/campaigns/c1"));
  expect(JSON.parse(call![1].body)).toEqual({ status: "active", expected_updated_at: 10 });
});
it("keeps a failed activation visible and never claims success", async () => {
  api.mockImplementation(async (path: string) => { if (path.endsWith("/campaigns/c1")) throw new Error("Insufficient ads balance"); return { balance_cents: 0 }; });
  const refresh = vi.fn(); render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={14} loading={false} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole("switch"));
  await confirmActivate();
  await screen.findByText("Insufficient ads balance");
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText("Campaign status updated.")).toBeNull();
});
it("fetches ad groups for only the owned campaigns with the selected period", async () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={7} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/channels/chatgpt_ads/campaigns/c1/entities?level=ad_group&days=7"));
});
it("refreshes an open entity tab when the dashboard returns a new snapshot", async () => {
  const props = { days: 7, loading: false, onRefresh: () => {} };
  const view = render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} {...props} payload={payload} />);
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  await screen.findByText("No ad groups found for this selection.");
  api.mockClear();
  view.rerender(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} {...props} payload={{ ...payload }} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/channels/chatgpt_ads/campaigns/c1/entities?level=ad_group&days=7"));
});
it("does not describe a missing dashboard response as an empty account", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={null} days={7} loading={false} onRefresh={() => {}} />);
  expect(screen.getByText("Account data is unavailable. Try Refresh.")).toBeTruthy();
  expect(screen.queryByText(/No campaigns are assigned/)).toBeNull();
});
it("a new tenant: auto-refill unticked, no amount field, Save card needs consent", async () => {
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet"));
  fireEvent.click(screen.getByRole("button", { name: "+ Add balance" }));
  expect(screen.getByRole("button", { name: "Card" })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole("spinbutton", { name: "Amount in USD" })).toBeNull();
  const submit = screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Authorize Zavi to charge this card for creator hires Autopilot books within its caps." }));
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(api.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
});
async function saveCard(wallet: Record<string, unknown>, toggleRefill: boolean) {
  api.mockImplementation(async (path: string) => path.endsWith("/wallet/checkout") ? { url: "https://checkout.stripe.com/c/1" } : path.endsWith("/wallet") ? { balance_cents: 10000, reserved_cents: 0, funding_enabled: true, ...wallet } : { rows: [] });
  Object.defineProperty(window, "location", { value: { ...window.location, assign: vi.fn() }, writable: true });
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet"));
  await waitFor(() => expect(screen.getByRole("button", { name: "+ Add balance" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "+ Add balance" }));
  const box = screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }) as HTMLInputElement;
  const initially = box.checked;
  if (toggleRefill) fireEvent.click(box);
  fireEvent.click(screen.getByRole("checkbox", { name: /^Authorize Zavi/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save card" }));
  await waitFor(() => expect(api.mock.calls.some(([url]) => url === "/api/ads/wallet/checkout")).toBe(true));
  const [, opts] = api.mock.calls.find(([url]) => url === "/api/ads/wallet/checkout")!;
  return { initially, body: JSON.parse(opts.body) };
}
it("a new tenant saves the card with refill off", async () => {
  const r = await saveCard({ auto_refill_enabled: false }, false);
  expect(r.initially).toBe(false);
  expect(r.body).toMatchObject({ mode: "setup", enable_refill: false, consent: true, amount_cents: 5000 });
});
it("a refill-on tenant sees the box ticked; unticking and saving sends refill off", async () => {
  const r = await saveCard({ auto_refill_enabled: true, refill_cents: 10000 }, true);
  expect(r.initially).toBe(true);
  expect(r.body).toMatchObject({ enable_refill: false });
});
it("ticking the box and saving sends refill on with the chosen amount", async () => {
  const r = await saveCard({ auto_refill_enabled: false }, true);
  expect(r.body).toMatchObject({ enable_refill: true, amount_cents: 10000 });
});
it("ticking auto-refill shows the amount and refill consent and resets the authorization", async () => {
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} />);
  fireEvent.click(await screen.findByRole("button", { name: "+ Add balance" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^Authorize Zavi/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }));
  expect(screen.getByRole("spinbutton", { name: "Amount in USD" })).toBeTruthy();
  const consent = screen.getByRole("checkbox", { name: "Authorize Zavi to charge this card for ChatGPT ads refills and for creator hires Autopilot books within its caps. Refills are $100.00 whenever your ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ChatGPT Ads channel at any time." }) as HTMLInputElement;
  expect(consent.checked).toBe(false);
  expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(consent);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Amount in USD" }), { target: { value: "1" } });
  expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(true);
});
it("first-use creation requires an explicitly entered lifetime budget", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [], no_campaigns_for_tenant: true }} days={14} loading={false} onRefresh={() => {}} />);
  expect(screen.queryByText(/Create your first campaign with Zavi/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Create campaign/i }));
  const editor = screen.getByRole("dialog", { name: "New ChatGPT Ads campaign" });
  const budget = within(editor).getByRole("spinbutton") as HTMLInputElement;
  expect(budget.value).toBe("");
  expect((within(editor).getByRole("button", { name: /Create paused campaign/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
});
it("hides Add balance when payments are off while leaving mandate cancellation available", async () => {
  api.mockResolvedValue({ balance_cents: 10000, funding_enabled: false, auto_refill_enabled: true, refill_cents: 10000 });
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} />);
  await screen.findByText(/Payments are unavailable/);
  expect(screen.queryByRole("button", { name: "+ Add balance" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Turn off auto-refill" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet/disable-refill", { method: "POST" }));
});
it("uses the same renderer for a different channel supplied entirely as data", async () => {
  const spec = { ...chatgpt_ads.campaignWorkspace!, title: "Other Ads", apiBase: "/api/channels/other_ads", metrics: [{ field: "clicks" as const, label: "Site traffic", help: "Measured visits", format: "count" as const }] };
  render(<CampaignWorkspace spec={spec} payload={payload} days={7} loading={false} onRefresh={() => {}} />);
  expect(screen.getByLabelText("Other Ads metrics")).toBeTruthy(); expect(screen.getByText("Site traffic")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch"));
  await confirmActivate();
  await waitFor(() => expect(api.mock.calls.some(([url]) => url === "/api/channels/other_ads/campaigns/c1")).toBe(true));
});
it("prefills a researched draft without an internal prefix or invented spending limit", () => {
  const draft = { type: "campaign_draft", name: "zv-acme--Buyer launch", bidding_type: "clicks", group: { name: "Intent", context_hints: ["Find a product"] }, ads: [] };
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [], no_campaigns_for_tenant: true, draft }} days={7} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Create campaign/i }));
  const editor = screen.getByRole("dialog", { name: "New ChatGPT Ads campaign" });
  expect((within(editor).getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Buyer launch");
  expect((within(editor).getByRole("spinbutton") as HTMLInputElement).value).toBe("");
});
it("Edit opens the editor as a modal over the still-mounted table; Close is held while saving", async () => {
  const base = api.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  api.mockImplementation((path: string, opts?: { method?: string }) => path.endsWith("/campaigns/c1")
    ? opts?.method === "POST" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ campaign })
    : base(path, opts));
  const drawerEscape = vi.fn();
  document.addEventListener("keydown", drawerEscape);
  try {
    render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={30} loading={false} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("dialog", { name: "Edit ChatGPT Ads campaign" });
    expect(screen.getByRole("table")).toBeTruthy();
    const name = await within(editor).findByLabelText("Campaign name") as HTMLInputElement;
    expect(name.value).toBe("Launch");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(drawerEscape).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Launch two" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    const close = within(editor).getByRole("button", { name: "Close" }) as HTMLButtonElement;
    await waitFor(() => expect(close.disabled).toBe(true));
    finish({ campaign: { ...campaign, name: "zv-acme--Launch two", updated_at: 11 } });
    await waitFor(() => expect((within(screen.getByRole("dialog", { name: "Edit ChatGPT Ads campaign" })).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit ChatGPT Ads campaign" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Edit ChatGPT Ads campaign" })).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
  } finally {
    document.removeEventListener("keydown", drawerEscape);
  }
});
it("retains campaign pause controls without performance figures", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, status: "active", spend: undefined, clicks: undefined }], totals_across_your_campaigns_only: {} }} days={7} loading={false} onRefresh={() => {}} />);
  expect((screen.getByRole("switch", { name: "Pause Launch" }) as HTMLButtonElement).disabled).toBe(false);
});
it("does not permit an auto-refill amount above the daily cap", async () => {
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} />);
  fireEvent.click(await screen.findByRole("button", { name: "+ Add balance" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^Authorize Zavi/ }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Amount in USD" }), { target: { value: "1001" } });
  expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(true);
});

it("activation opens a confirmation with budget, bids, countries and ad previews; Cancel writes nothing", async () => {
  api.mockImplementation(async (path: string) =>
    path.endsWith("level=ad_group&days=30") ? { rows: [
      { id: "g1", name: "Intent", status: "active", campaign_id: "c1", parent_name: "Launch", bidding_config: { strategy: "fixed_bid", max_bid_micros: 1_500_000 } },
      { id: "g2", name: "Auto", status: "paused", campaign_id: "c1", parent_name: "Launch", bidding_config: { strategy: "maximize_clicks" } },
    ] }
    : path.endsWith("level=ad&days=30") ? { rows: [
      { id: "a1", name: "Card one", status: "active", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { title: "A useful product", body: "Browse the collection", target_url: "https://client.example/offer", image_url: "https://cdn.example/one.png" } },
      { id: "a2", name: "Paused card", status: "paused", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { title: "Paused card" } },
      { id: "a3", name: "Rejected card", status: "active", review_status: "rejected", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { title: "Rejected card" } },
      { id: "a4", name: "Orphan card", status: "active", campaign_id: "c1", ad_group_id: "g2", parent_name: "Auto", creative: { title: "Orphan card" } },
    ] }
    : path.endsWith("/wallet") ? { balance_cents: 10000, reserved_cents: 0, funding_enabled: true, auto_refill_enabled: false } : { rows: [] });
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, bidding_type: "clicks" }] }} days={14} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("switch", { name: "Activate Launch" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Activating starts spend from your balance.");
  expect(within(dialog).getByTestId("activate-budget").textContent).toBe("$100.00 total");
  await waitFor(() => expect(within(dialog).getByTestId("activate-bids").textContent).toContain("Intent: $1.50"));
  expect(within(dialog).getByTestId("activate-bids").textContent).toContain("Auto: Automatic");
  expect(within(dialog).getByTestId("activate-countries").textContent).toMatch(/No country set: ads can show in every available location/);
  expect(within(dialog).getAllByTestId("activate-preview")).toHaveLength(1);
  expect(dialog.textContent).toContain("A useful product");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.mock.calls.some(([p]) => p.endsWith("/campaigns/c1"))).toBe(false);
});
it("with every group and ad paused, says plainly that no ad will serve", async () => {
  api.mockImplementation(async (path: string) =>
    path.endsWith("level=ad_group&days=30") ? { rows: [{ id: "g1", name: "Intent", status: "paused", campaign_id: "c1", parent_name: "Launch" }] }
    : path.endsWith("level=ad&days=30") ? { rows: [{ id: "a1", name: "Card one", status: "paused", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { title: "A useful product" } }] }
    : { rows: [] });
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={14} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("switch", { name: "Activate Launch" }));
  const dialog = await screen.findByRole("dialog");
  expect((await within(dialog).findByTestId("activate-no-serving")).textContent).toBe("No ad will serve yet: activate an ad group and an ad too.");
  expect(within(dialog).queryAllByTestId("activate-preview")).toHaveLength(0);
});
it.each([
  [{ excluded_locations: { countries: ["GB"] } }, "Every available location, excluding GB"],
  [{ locations: { countries: ["US"] }, excluded_locations: { include: [{ id: "l1", name: "Texas" }] } }, "US; excluding Texas"],
])("shows excluded locations: %j", async (targeting, text) => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, targeting }] }} days={14} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("switch", { name: "Activate Launch" }));
  expect((await screen.findByTestId("activate-countries")).textContent).toBe(text);
});
it("names the countries when the campaign sets them", async () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, targeting: { locations: { countries: ["US", "CA"] } } }] }} days={14} loading={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("switch", { name: "Activate Launch" }));
  expect((await screen.findByTestId("activate-countries")).textContent).toBe("US, CA");
});
it("pausing stays one click, no confirmation", async () => {
  const refresh = vi.fn();
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, status: "active" }] }} days={14} loading={false} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole("switch", { name: "Pause Launch" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  const call = api.mock.calls.find(([p]) => p.endsWith("/campaigns/c1"));
  expect(JSON.parse(call![1].body)).toMatchObject({ status: "paused" });
});
it("with no campaigns, shows the metric tiles and an empty campaign table, with no create box or balance card", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [], no_campaigns_for_tenant: true }} days={14} loading={false} onRefresh={() => {}} />);
  expect(screen.getByRole("region", { name: /metrics/ })).toBeTruthy();
  expect(screen.getByText("No campaigns yet.")).toBeTruthy();
  expect(screen.queryByText(/Create your first campaign with Zavi/)).toBeNull();
  expect(screen.queryByText("Shared ads balance")).toBeNull();
});

it("a paused campaign offers one Launch that opens the launch sheet; a live one does not", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/launch")
    ? { state: "ready", campaign: { id: "c1", name: "zv-acme--Launch", status: "paused", updated_at: 10, bidding_type: "clicks", lifetime_budget_micros: 100000000, daily_budget_micros: null, countries: ["US"] }, groups: [], ads: [], wallet: null, shortfall_cents: 0 }
    : path.endsWith("/wallet") ? { balance_cents: 10000, reserved_cents: 0, funding_enabled: true, auto_refill_enabled: false } : {});
  const view = render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={14} loading={false} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByTestId("launch-campaign"));
  await screen.findByText("Finish campaign setup");
  expect(api).toHaveBeenCalledWith("/api/channels/chatgpt_ads/campaigns/c1/launch");
  cleanup();
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, status: "active" }] }} days={14} loading={false} onRefresh={vi.fn()} />);
  expect(screen.queryByTestId("launch-campaign")).toBeNull();
  void view;
});

it("distinguishes the platform active switch from a campaign whose schedule ended", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, status: "active", end_time: 1 }] }} days={30} loading={false} onRefresh={() => {}} />);
  expect(screen.getByText("Schedule ended")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Pause Launch" }).getAttribute("aria-checked")).toBe("true");
});

it("says plainly when conversion tracking is not set up, and ad rows carry their campaign and Edit", async () => {
  api.mockImplementation(async (path: string) => path.includes("/entities") ? { rows: [{ id: "g1", name: "Intent group", status: "active", campaign_id: "c1", parent_name: "Launch", impressions: 0 }] } : { rows: [] });
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, conversion_tracking: "not_configured" }} days={7} loading={false} onRefresh={() => {}} />);
  expect(screen.getByText(/Conversion tracking is not set up yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Ad groups" }));
  const row = (await screen.findByText("Intent group")).closest("tr")!;
  expect(within(row).getByText("Launch")).toBeTruthy();
  expect(within(row).getByText("–")).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Edit" })).toBeTruthy();
});
it("shows the daily budget of active campaigns, and Change opens the only one", async () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, campaigns: [{ ...campaign, status: "active", budget: { daily_spend_limit_micros: 25000000 }, end_time: 4102444800 }] }} days={30} loading={false} onRefresh={() => {}} />);
  expect(screen.getByTestId("value-daily_budget").textContent).toBe("$25");
  expect(screen.getByText("Across 1 active campaign")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  expect(await screen.findByRole("dialog", { name: "Edit ChatGPT Ads campaign" })).toBeTruthy();
});
it("the balance card says what is available to spend everywhere except in LinkedIn Ads settings", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/wallet") ? { balance_cents: 10000, available_cents: 7500, reserved_cents: 2500, funding_enabled: true, auto_refill_enabled: false } : { rows: [] });
  const chatgpt = render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} variant="card" />);
  expect(await screen.findByText("$75.00 available")).toBeTruthy();
  expect(screen.getByText("$25.00 reserved")).toBeTruthy();
  chatgpt.unmount();
  render(<ChannelBalance spec={chatgpt_ads.campaignWorkspace!} platform="linkedin" variant="card" />);
  expect(await screen.findByText("$25.00 reserved")).toBeTruthy();
  expect(screen.queryByText(/available/)).toBeNull();
});

it("explains attributed ROAS even when conversion tracking is configured", () => {
  render(<CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={{ ...payload, conversion_tracking: "configured", purchase_return: { roas: 2.5 } }} days={7} loading={false} onRefresh={() => {}} />);
  expect(screen.getByTestId("value-roas").textContent).toBe("2.50×");
  expect(screen.getByText("Attributed sales per dollar spent")).toBeTruthy();
  expect(screen.getByText(/Conversions and return on ad spend are provider-reported and do not prove bookings or sales/)).toBeTruthy();
  expect(screen.queryByText("Bookings for every dollar spent")).toBeNull();
});
it("Create campaign from another tab opens the editor outside the hidden Analytics tab", () => {
  render(
    <div className="workspace-shell" data-testid="shell">
      <div hidden data-testid="analytics-tab">
        <CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={payload} days={14} loading={false} onRefresh={() => {}} />
      </div>
    </div>,
  );
  let opened = false;
  act(() => { opened = openNewCampaign(); });
  expect(opened).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "New ChatGPT Ads campaign" });
  expect(screen.getByTestId("analytics-tab").contains(dialog)).toBe(false);
  expect(screen.getByTestId("shell").contains(dialog)).toBe(true);
});
