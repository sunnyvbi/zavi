// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
const raw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: raw }));
vi.mock("./api", () => ({ campaignFetch: api, requestKey: (_old: unknown, _path: string, body: unknown) => ({ signature: JSON.stringify(body), id: "11111111-1111-4111-8111-111111111111" }) }));
import { chatgpt_ads } from "../platforms/chatgpt_ads";
import { CampaignAssets } from "./CampaignAssets";

const campaign = { id: "c1", name: "Launch", status: "active", updated_at: 7, bidding_type: "clicks", budget: { daily_spend_limit_micros: 30_000_000 }, targeting: { locations: { countries: ["US"] } } };
const groups = [{ id: "g1", name: "Intent", status: "paused", campaign_id: "c1", parent_name: "Launch", bidding_config: { strategy: "fixed_bid", max_bid_micros: 2_000_000 } }];
const ads = [
  { id: "a1", name: "Card one", status: "active", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { type: "chat_card", title: "A useful product", body: "Browse" } },
  { id: "a2", name: "Card two", status: "paused", campaign_id: "c1", ad_group_id: "g1", parent_name: "Intent", creative: { type: "chat_card", title: "Still paused", body: "Browse" } },
];
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string) => path.includes("level=ad_group") ? { rows: groups } : path.includes("level=ad&") ? { rows: ads } : {});
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); });

it("Activate group shows the daily budget, the group's bid, countries and its ads, then writes on confirm", async () => {
  render(<CampaignAssets spec={chatgpt_ads.campaignWorkspace!} campaignId="c1" campaign={campaign} currency="USD" />);
  fireEvent.click(await screen.findByRole("button", { name: "Activate group" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByTestId("activate-budget").textContent).toBe("$30.00 per day");
  expect(within(dialog).getByTestId("activate-bids").textContent).toBe("Intent: $2.00");
  expect(within(dialog).getByTestId("activate-countries").textContent).toBe("US");
  expect(within(dialog).getAllByTestId("activate-preview")).toHaveLength(1);
  expect(api.mock.calls.some(([p, o]) => p.endsWith("/ad-groups/g1") && o?.method === "POST")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Activate" }));
  await waitFor(() => expect(api.mock.calls.some(([p, o]) => p.endsWith("/ad-groups/g1") && o?.method === "POST")).toBe(true));
  const call = api.mock.calls.find(([p, o]) => p.endsWith("/ad-groups/g1") && o?.method === "POST");
  expect(JSON.parse(call![1].body)).toEqual({ status: "active", expected_campaign_updated_at: 7 });
});

it("Activate ad in a paused campaign lists no serving ad and says what else to activate", async () => {
  render(<CampaignAssets spec={chatgpt_ads.campaignWorkspace!} campaignId="c1" campaign={{ ...campaign, status: "paused" }} currency="USD" />);
  fireEvent.click(await screen.findByRole("button", { name: "Activate ad" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryAllByTestId("activate-preview")).toHaveLength(0);
  expect(within(dialog).getByTestId("activate-no-serving").textContent).toBe("No ad will serve yet: activate the campaign and an ad group too.");
});

it("Activate ad confirms first; Cancel writes nothing", async () => {
  render(<CampaignAssets spec={chatgpt_ads.campaignWorkspace!} campaignId="c1" campaign={campaign} currency="USD" />);
  fireEvent.click(await screen.findByRole("button", { name: "Activate ad" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Activate ad “Still paused”?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});

it("a hand-made ad takes an uploaded image as a private path, and is not saved without one", async () => {
  const path = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg";
  raw.mockResolvedValue({ ok: true, json: async () => ({ image_path: path }) });
  api.mockImplementation(async (p: string) => p.includes("level=ad_group") ? { rows: groups } : p.includes("level=ad&") ? { rows: ads } : p.startsWith("/api/chat/image-url") ? { signed_url: "https://storage.example/x" } : {});
  render(<CampaignAssets spec={chatgpt_ads.campaignWorkspace!} campaignId="c1" campaign={campaign} currency="USD" />);
  fireEvent.click(await screen.findByRole("button", { name: "Add ad" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hand made ad" } });
  fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "A useful product" } });
  fireEvent.change(screen.getByLabelText(/^Ad copy/), { target: { value: "Browse the range" } });
  fireEvent.change(screen.getByLabelText("Sending visitors to"), { target: { value: "https://client.example/offer" } });
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await screen.findByText("Choose an image for the ad.");
  expect(api.mock.calls.some(([p]) => p.includes("/creatives"))).toBe(false);
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Save paused" }) as HTMLButtonElement).disabled).toBe(false));
  await screen.findByRole("button", { name: "Replace" });
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith("/creatives"))).toBe(true));
  const body = JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/creatives"))![1].body);
  expect(body).toMatchObject({ image_path: path, target_url: "https://client.example/offer" });
  expect(body).not.toHaveProperty("image_url");
});

it.each(["group", "ad"] as const)("retains a saved %s receipt while the provider list lags, and refresh never creates it again", async kind => {
  let listed = false;
  const savedId = kind === "group" ? "new-group" : "new-ad";
  const savedGroup = { ...groups[0], id: savedId, name: "Saved group" };
  const savedAd = { ...ads[1], id: savedId, name: "Saved ad", creative: { type: "product_ad_template", title: "Saved ad", body: "Browse" } };
  api.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return { id: savedId, status: "paused" };
    if (path.includes("level=ad_group")) return { rows: kind === "ad" ? groups : listed ? [savedGroup] : [] };
    if (path.includes("level=ad&")) return { rows: kind === "ad" && listed ? [savedAd] : [] };
    return {};
  });
  render(<CampaignAssets spec={chatgpt_ads.campaignWorkspace!} campaignId="c1" campaign={{ ...campaign, status: "paused", mode: "product_feed" }} currency="USD" />);
  await waitFor(() => expect(screen.queryByText("Reading campaign creatives…")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: kind === "group" ? "Add ad group" : "Add ad" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saved item" } });
  if (kind === "group") fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1" } });
  else {
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Saved ad" } });
    fireEvent.change(screen.getByLabelText(/^Ad copy/), { target: { value: "Browse" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await screen.findByText(kind === "group" ? "Ad group created and paused." : "Ad created and paused.");
  expect(screen.getByText(/Do not create it again/).textContent).toContain(savedId);
  expect(screen.queryByText(/Add an ad group with buyer context/)).toBeNull();
  if (kind === "group") expect((screen.getByRole("button", { name: "Add ad" }) as HTMLButtonElement).disabled).toBe(true);
  const refresh = screen.getByRole("button", { name: "Refresh saved items" }) as HTMLButtonElement;
  await waitFor(() => expect(refresh.disabled).toBe(false));
  fireEvent.click(refresh);
  await waitFor(() => expect(refresh.disabled).toBe(false));
  expect(screen.getByText(/Do not create it again/)).toBeTruthy();
  listed = true;
  fireEvent.click(refresh);
  await waitFor(() => expect(screen.queryByText(/Do not create it again/)).toBeNull());
  expect(screen.getByText(kind === "group" ? "Saved group" : "Saved ad")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add ad" }) as HTMLButtonElement).disabled).toBe(false);
  expect(api.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});
