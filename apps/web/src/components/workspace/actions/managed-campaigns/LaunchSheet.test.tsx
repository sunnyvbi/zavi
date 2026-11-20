// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => vi.fn());
const raw = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("@/lib/api", () => ({ apiFetch: raw }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: (p: { suggestedAmount?: number }) => <div data-testid="balance" data-amount={p.suggestedAmount ?? ""} /> }));
import { LaunchSheet } from "./LaunchSheet";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const spec = chatgpt_ads.campaignWorkspace!;
const summary = (over: Record<string, unknown> = {}) => ({
  state: "ready",
  campaign: { id: "c1", name: "zv-acme--Launch", status: "paused", updated_at: 10, bidding_type: "clicks", lifetime_budget_micros: 100_000_000, daily_budget_micros: null, countries: ["US", "CA"] },
  groups: [{ id: "g1", name: "Buyer intent", status: "paused", max_bid_micros: 2_000_000 }],
  ads: [
    { id: "a1", ad_group_id: "g1", name: "Card A", status: "paused", review_status: "approved", title: "Explore A", body: "Find it", target_url: "https://client.example" },
    { id: "a2", ad_group_id: "g1", name: "Card B", status: "paused", review_status: null, title: "Explore B", body: "Find more", target_url: "https://client.example" },
  ],
  wallet: { currency: "USD", available_cents: 20_000, funding_enabled: true, in_app_enabled: true },
  shortfall_cents: 0,
  snapshot: "a".repeat(64),
  ...over,
});
let current: Record<string, unknown>;
beforeEach(() => {
  current = summary(); api.mockReset(); raw.mockReset();
  api.mockImplementation(async () => current);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
const launchButton = () => screen.getByRole("button", { name: /^Launch|Finish launch/ }) as HTMLButtonElement;
const answer = (status: number, body: unknown) => raw.mockResolvedValueOnce({ ok: status < 300, status, json: async () => body });

it("states the cap, the most per visit, where it shows and the ads, before anything turns on", async () => {
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  expect((await screen.findByTestId("launch-cap")).textContent).toBe("$100.00 in total");
  expect(screen.getByTestId("launch-bid").textContent).toBe("$2.00");
  expect(screen.getByTestId("launch-countries").textContent).toBe("United States, Canada");
  expect(screen.getAllByTestId("launch-ad").map(li => li.textContent)).toEqual([expect.stringContaining("Explore A"), expect.stringContaining("Explore B")]);
  expect(screen.getByText(/Launching turns on your 2 ads\. Zavi may spend up to \$100\.00 in total, at most \$2\.00 per result/)).toBeTruthy();
  expect(launchButton().textContent).toBe("Launch · up to $100.00");
  expect(api).toHaveBeenCalledWith("/api/channels/chatgpt_ads/campaigns/c1/launch");
  expect(raw).not.toHaveBeenCalled();
});
it("sends the version the founder saw, and shows the campaign is on", async () => {
  const launched = vi.fn();
  answer(200, { ok: true, items: [{ kind: "campaign", id: "c1", name: "Launch", status: "activated" }] });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} onLaunched={launched} />);
  await screen.findByTestId("launch-cap");
  fireEvent.click(launchButton());
  await screen.findByText("Your campaign is on");
  const [path, init] = raw.mock.calls[0];
  expect(path).toBe("/api/channels/chatgpt_ads/campaigns/c1/launch");
  expect(init).toMatchObject({ method: "POST", retryOnNetworkError: false });
  expect(JSON.parse(init.body)).toEqual({ expected_updated_at: 10, snapshot: "a".repeat(64) });
  expect(launched).toHaveBeenCalled();
});
it("a short balance holds Launch and opens Add balance at what is missing", async () => {
  current = summary({ shortfall_cents: 7_550 });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByText(/Add about \$76\.00 to cover the spend cap/);
  expect(launchButton().disabled).toBe(true);
  expect(screen.getByTestId("balance").getAttribute("data-amount")).toBe("76");
});
it("a partial launch lists each item and offers to finish, re-reading the campaign first", async () => {
  answer(409, { ok: false, code: "chatgpt_ads_unavailable", message: "Part of the campaign is on. Nothing ran twice. Finish the launch when you are ready.", items: [
    { kind: "campaign", id: "c1", name: "Launch", status: "activated" },
    { kind: "ad", id: "a2", name: "Explore B", status: "failed", reason: "The platform did not confirm this change." },
  ] });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByTestId("launch-cap");
  fireEvent.click(launchButton());
  await screen.findByText(/Part of the campaign is on/);
  expect(screen.getByText(/Ad “Explore B”: Not turned on\. The platform did not confirm this change\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Finish launch" })).toBeTruthy();
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
});
it("a refusal before anything turned on shows the platform's reason", async () => {
  answer(409, { ok: false, code: "ads_balance_insufficient", message: "Available ads balance must cover the campaign’s reserved campaign budget.", items: [{ kind: "campaign", id: "c1", name: "Launch", status: "failed", reason: "x" }] });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByTestId("launch-cap");
  fireEvent.click(launchButton());
  await screen.findByText(/must cover the campaign’s reserved campaign budget/);
  expect(screen.queryByRole("button", { name: "Finish launch" })).toBeNull();
});
it("no answer at all is reported as unknown, never as success", async () => {
  raw.mockRejectedValueOnce(new Error("network"));
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByTestId("launch-cap");
  fireEvent.click(launchButton());
  await screen.findByText(/The launch did not answer/);
  expect(screen.queryByText("Your campaign is on")).toBeNull();
});
it("an ad the platform rejected is shown as staying off, and is not counted", async () => {
  current = summary({ ads: [{ ...summary().ads[0], review_status: "rejected" }, summary().ads[1]] });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByText("Not approved by the platform; it stays off.");
  expect(screen.getByText("1 of 2 can show")).toBeTruthy();
});
it("an already-live campaign reads as on, with nothing to launch", async () => {
  current = summary({ state: "launched" });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByText("Your campaign is on");
  expect(screen.queryByRole("button", { name: /^Launch/ })).toBeNull();
});
it("a campaign that cannot be read says so and can be retried", async () => {
  api.mockRejectedValueOnce(new Error("Campaign not found in this workspace."));
  render(<LaunchSheet campaignId="theirs" spec={spec} onClose={vi.fn()} />);
  await screen.findByText(/Campaign not found in this workspace/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByTestId("launch-cap");
});
it("a daily budget is shown as an average with its one-day maximum", async () => {
  current = summary({ campaign: { ...summary().campaign, lifetime_budget_micros: null, daily_budget_micros: 25_000_000 } });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  expect((await screen.findByTestId("launch-cap")).textContent).toBe("$25.00 a day on average, up to $50.00 on any one day");
});

it("unknown funding blocks launch and offers a fresh read", async () => {
  current = summary({ shortfall_cents: null, wallet: null });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByText(/Campaign funding could not be verified/);
  expect(launchButton().disabled).toBe(true);
  current = summary();
  fireEvent.click(screen.getByRole("button", { name: "Refresh funding" }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(raw).not.toHaveBeenCalled();
});

it.each([
  { groups: [], ads: [], explanation: "No ad groups are listed yet." },
  { groups: summary().groups, ads: [], explanation: "No ads are listed yet." },
  { groups: summary().groups, ads: [{ ...summary().ads[0], review_status: "rejected" }], explanation: "None of these ads can launch" },
])("explains incomplete setup and refreshes without writing ($explanation)", async ({ groups, ads, explanation }) => {
  current = summary({ groups, ads });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByRole("heading", { name: "Finish campaign setup" });
  expect(screen.getByText(text => text.startsWith(explanation))).toBeTruthy();
  expect(launchButton().disabled).toBe(true);
  expect(screen.queryByText(/Launching turns on/)).toBeNull();
  current = summary();
  fireEvent.click(screen.getByRole("button", { name: "Refresh campaign" }));
  await screen.findByRole("heading", { name: "Review campaign" });
  expect(launchButton().disabled).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
  expect(raw).not.toHaveBeenCalled();
});

it.each([
  [{ locations: { include: [{ id: "geo-us", name: "United States" }] } }, "United States"],
  [{ locations: { include: [{ id: "geo-city" }] } }, "geo-city"],
  [{ locations: { include: [{ id: "geo-us", name: "United States" }] }, excluded_locations: { countries: ["CA"], include: [{ id: "geo-city", name: "Austin" }] } }, "United States; excluding Canada, Austin"],
  [{ excluded_locations: { countries: ["GB"] } }, "Every available location, excluding United Kingdom"],
  [{}, "No country set: ads can show in every available location"],
])("renders the full location selection rather than treating missing country codes as worldwide", async (targeting, text) => {
  current = summary({ campaign: { ...summary().campaign, countries: [], targeting } });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  expect((await screen.findByTestId("launch-countries")).textContent).toBe(text);
  expect(raw).not.toHaveBeenCalled();
});

it("shows a conversion bid separately from the total cap without guaranteeing the conversion price", async () => {
  current = summary({ campaign: { ...summary().campaign, bidding_type: "conversions" }, groups: [{ ...summary().groups[0], max_bid_micros: 25_000_000 }] });
  render(<LaunchSheet campaignId="c1" spec={spec} onClose={vi.fn()} />);
  await screen.findByTestId("launch-cap");
  expect(screen.getByText("Bid for one customer action")).toBeTruthy();
  expect(screen.getByTestId("launch-bid").textContent).toBe("$25.00");
  expect(screen.getByText(/Billed per valid click, not per conversion/)).toBeTruthy();
  expect(screen.queryByText(/at most \$25.00 per result/)).toBeNull();
  expect(launchButton().textContent).toBe("Launch · up to $100.00");
  expect(raw).not.toHaveBeenCalled();
});

it("does not infer billing rules from a generic conversion-event requirement", async () => {
  current = summary({ campaign: { ...summary().campaign, bidding_type: "custom" } });
  const otherSpec = { ...spec, objectives: [{ value: "custom", label: "Custom goal", requiresEvent: true }] };
  render(<LaunchSheet campaignId="c1" spec={otherSpec} onClose={vi.fn()} />);
  await screen.findByTestId("launch-cap");
  expect(screen.queryByText(/Billed per valid click/)).toBeNull();
});
