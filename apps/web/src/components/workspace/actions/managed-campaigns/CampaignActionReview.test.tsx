// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignActionReview } from "./CampaignActionReview";
import { ChannelActionCard } from "../ChannelActionCard";
import { chatgpt_ads } from "../platforms/chatgpt_ads";
import { linkedin_ads } from "../platforms/linkedin_ads";
import type { ActionItem } from "../types";
const api = vi.hoisted(() => vi.fn());
const raw = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
vi.mock("@/lib/api", () => ({ apiFetch: raw }));

const tenant = "11111111-1111-4111-8111-111111111111";
const uploaded = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
const made = `${tenant}/44444444-4444-4444-8444-444444444444.jpg`;
const ad = (n: string, extra: Record<string, unknown> = {}) => ({ name: `Card ${n}`, title: `Explore ${n}`, body: "Find your next product", target_url: "https://www.client.example/offer", tracking: "utm_source=chatgpt", image_spec: "A bright product photo on a table", ...extra });
const draft = { type: "campaign_draft", name: "Collection launch", bidding_type: "clicks", group: { name: "Buyer intent", context_hints: ["Which product fits?", "best gift under $50"] }, ads: [ad("A"), ad("B")] };
const suggested = { lifetime_budget_micros: 100_000_000, max_bid_micros: 2_000_000, countries: ["US"], budget_source: "starter", countries_source: "default" };
const reviewBody = (over: Record<string, unknown> = {}) => ({ draft, currency: "USD", suggested, ai_image: { available: true, credits: 40 }, ...over });
const action = { run_id: null, position: 1, run_of: 1, blocking: false, note: null, snoozed_until: null, impact: null, impact_reason: null, score: 0, score_inputs: {}, proposed_at: "2026-09-25T00:00:00Z", repeat_of: null, redo_of: null, source: "channel_action", edited_body: null, id: "action-1", channel_slug: "chatgpt_ads", action_type: "create_ad", title: "Let Zavi create this campaign", status: "pending", executable: false, exec_status: null, card_kind: "ad_manual", primary_label: "Copy ad", body: { step: { responsibility: "client", body: "A researched test", deliverable: { kind: "ad", content: "Finished copy", presentation: draft } } } } as ActionItem;
const handlers = () => ({ onApprove: vi.fn().mockResolvedValue(true), onSetStatus: vi.fn(), onRedo: vi.fn() });
let review: Record<string, unknown>;
beforeEach(() => {
  review = reviewBody();
  api.mockReset(); raw.mockReset(); ws.role = "owner";
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review
    : path.endsWith("/ad-image") ? { image_path: made }
    : path.startsWith("/api/chat/image-url") ? { signed_url: "https://storage.example/preview" }
    : { exact_change: { rows: [] } });
  raw.mockResolvedValue({ ok: true, json: async () => ({ image_path: uploaded }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
function open(h = handlers()) {
  const close = vi.fn(), prepared = vi.fn();
  render(<CampaignActionReview action={action} spec={chatgpt_ads.campaignWorkspace!} handlers={h} onPrepared={prepared} onClose={close} />);
  return { h, close, prepared };
}
const createButton = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
const prepareBody = () => JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body);

it("replaces manual Copy ad with the common review action only for structured managed drafts", () => {
  const view = render(<ChannelActionCard action={action} platform={chatgpt_ads} handlers={handlers()} />);
  expect(screen.getByRole("button", { name: "Review and create" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy ad" })).toBeNull();
  view.rerender(<ChannelActionCard action={action} platform={{ ...chatgpt_ads, campaignWorkspace: undefined }} handlers={handlers()} />);
  expect(screen.queryByRole("button", { name: "Review and create" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy ad" })).toBeTruthy();
});
it("leads with the goal in plain words and the situations the ad shows in", async () => {
  open();
  expect(await screen.findByText("Get people to visit client.example")).toBeTruthy();
  expect(screen.getByText("Shown when people ask ChatGPT about:")).toBeTruthy();
  expect(screen.getByText("best gift under $50")).toBeTruthy();
});
it("prefills the starter spend, bid and country, each labelled as a default", async () => {
  open();
  const spend = await screen.findByLabelText("Spend up to, in total (USD)") as HTMLInputElement;
  expect(spend.value).toBe("100");
  expect(screen.getByText("Zavi starter test · change anytime")).toBeTruthy();
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("US");
  expect(screen.getByText("Default · change if needed")).toBeTruthy();
  const bid = screen.getByLabelText("Most you pay for one visit (USD)") as HTMLInputElement;
  expect(bid.value).toBe("2");
  expect(bid.closest("details")).not.toBeNull();
  fireEvent.change(spend, { target: { value: "250" } });
  expect(screen.queryByText("Zavi starter test · change anytime")).toBeNull();
});
it("says when the country came from the company profile", async () => {
  review = reviewBody({ suggested: { ...suggested, countries: ["CA"], countries_source: "company_profile" } });
  open();
  await screen.findByText("From your company profile");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("CA");
});
it("never creates without an image, and one uploaded image serves both ads", async () => {
  const { h, close, prepared } = open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  expect(createButton().disabled).toBe(true);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "photo.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(createButton().disabled).toBe(false));
  expect(raw).toHaveBeenCalledWith("/api/chat/upload-image", expect.objectContaining({ method: "POST" }));
  fireEvent.click(createButton());
  await waitFor(() => expect(h.onApprove).toHaveBeenCalledTimes(1));
  expect(prepareBody()).toEqual({ currency: "USD", lifetime_budget_micros: 100_000_000, max_bid_micros: 2_000_000, countries: ["US"], image_urls: [uploaded, uploaded] });
  expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ id: action.id, executable: true }));
  expect(close).toHaveBeenCalled();
});
it("refuses a file that is not an image or is too large, without uploading", async () => {
  open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "doc.pdf", { type: "application/pdf" })] } });
  await screen.findByText("Use a JPG, PNG or WebP image.");
  const big = new File(["x"], "big.jpg", { type: "image/jpeg" }); Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [big] } });
  await screen.findByText("That file is over 5 MB. Choose a smaller image.");
  expect(raw).not.toHaveBeenCalled();
});
it("Create with AI shows its cost first, uses Zavi's image idea, and fills the slot", async () => {
  open();
  const ai = await screen.findByRole("button", { name: /Create with AI · ~40 credits/ });
  expect(screen.getByText(/A bright product photo on a table/)).toBeTruthy();
  fireEvent.click(ai);
  await waitFor(() => expect(createButton().disabled).toBe(false));
  const call = api.mock.calls.find(([p]) => p.endsWith("/ad-image"))!;
  expect(call[0]).toBe("/api/channels/chatgpt_ads/actions/action-1/ad-image");
  expect(JSON.parse(call[1].body)).toEqual({ prompt: "A bright product photo on a table" });
  fireEvent.click(createButton());
  await waitFor(() => expect(prepareBody().image_urls).toEqual([made, made]));
});
it("hides Create with AI when the server says it is unavailable", async () => {
  review = reviewBody({ ai_image: { available: false, credits: null } });
  open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  expect(screen.queryByRole("button", { name: /Create with AI/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Upload image" }).length).toBeGreaterThan(0);
});
it("shows an AI refusal and keeps the founder in control", async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review;
    if (path.endsWith("/ad-image")) throw new Error("You don't have enough credits for an AI image. Add credits or upload your own image.");
    return {};
  });
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Create with AI/ }));
  await screen.findByText(/enough credits/);
  expect(createButton().disabled).toBe(true);
});
it("a different image per ad sends each ad its own image", async () => {
  open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  fireEvent.click(screen.getByLabelText("Use a different image for each ad"));
  fireEvent.click(screen.getByRole("button", { name: /Create with AI/ }));
  await waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith("/ad-image"))).toBe(true));
  await waitFor(() => expect(createButton().disabled).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: "Ad 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Use an image link instead" }));
  fireEvent.change(screen.getByLabelText("Image link"), { target: { value: "https://cdn.example/b.png" } });
  fireEvent.click(screen.getByRole("button", { name: "Use link" }));
  await waitFor(() => expect(createButton().disabled).toBe(false));
  fireEvent.click(createButton());
  await waitFor(() => expect(prepareBody().image_urls).toEqual([made, "https://cdn.example/b.png"]));
});
it("asks for the bid on screen when there is no starter value (non-USD account)", async () => {
  review = reviewBody({ currency: "EUR", suggested: { ...suggested, lifetime_budget_micros: null, max_bid_micros: null } });
  open();
  const bid = await screen.findByLabelText("Most you pay for one visit (EUR)") as HTMLInputElement;
  expect(bid.value).toBe("");
  expect((screen.getByLabelText("Spend up to, in total (EUR)") as HTMLInputElement).value).toBe("");
  expect(screen.getByText(/no starter value for this goal/)).toBeTruthy();
  expect(bid.closest("details")).toBeNull();
});
it("converts a per-1,000-views bid to per-impression micros", async () => {
  review = reviewBody({ draft: { ...draft, bidding_type: "impressions", ads: [ad("A", { image_url: "https://cdn.example/a.png" })] }, suggested: { ...suggested, max_bid_micros: null } });
  const { h } = open();
  fireEvent.change(await screen.findByLabelText("Most you pay for 1,000 views (USD)"), { target: { value: "10" } });
  fireEvent.click(createButton());
  await waitFor(() => expect(h.onApprove).toHaveBeenCalled());
  expect(prepareBody()).toMatchObject({ max_bid_micros: 10000, image_urls: ["https://cdn.example/a.png"] });
});
it("adds more countries from More settings", async () => {
  review = reviewBody({ draft: { ...draft, ads: [ad("A", { image_url: "https://cdn.example/a.png" })] } });
  open();
  fireEvent.change(await screen.findByLabelText("More countries (optional)"), { target: { value: "ca, gb, US" } });
  fireEvent.click(createButton());
  await waitFor(() => expect(prepareBody().countries).toEqual(["US", "CA", "GB"]));
});
it("keeps a prepare failure visible without approving", async () => {
  review = reviewBody({ draft: { ...draft, ads: [ad("A", { image_url: "https://cdn.example/a.png" })] } });
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review;
    if (path.endsWith("/prepare")) throw new Error("This action changed. Refresh Next steps before approving.");
    return { signed_url: "x" };
  });
  const { h, close } = open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  fireEvent.click(createButton());
  await screen.findByText("This action changed. Refresh Next steps before approving.");
  expect(h.onApprove).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
it("says plainly that nothing spends until launch", async () => {
  open();
  expect(await screen.findByText(/Created paused\. Nothing spends until you launch it from your campaign list, and then at most \$100\.00 in total/)).toBeTruthy();
});
it("holds the sheet open while an AI image is being made (it is already being paid for)", async () => {
  let finish: (v: unknown) => void = () => {};
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review
    : path.endsWith("/ad-image") ? new Promise(r => { finish = r; })
    : path.startsWith("/api/chat/image-url") ? { signed_url: "x" } : {});
  const { close } = open();
  fireEvent.click(await screen.findByRole("button", { name: /Create with AI/ }));
  const closeButton = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
  await waitFor(() => expect(closeButton.disabled).toBe(true));
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  finish({ image_path: made });
  await waitFor(() => expect(closeButton.disabled).toBe(false));
  expect(close).not.toHaveBeenCalled();
});
it("each New AI image click asks for a new version", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Create with AI/ }));
  fireEvent.click(await screen.findByRole("button", { name: /New AI image/ }));
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p.endsWith("/ad-image")).length).toBe(2));
  const bodies = api.mock.calls.filter(([p]) => p.endsWith("/ad-image")).map(([, init]) => JSON.parse(init.body));
  expect(bodies).toEqual([{ prompt: "A bright product photo on a table" }, { prompt: "A bright product photo on a table", variation: 2 }]);
});
it("switching ad tabs keeps each ad's next AI version", async () => {
  open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  fireEvent.click(screen.getByLabelText("Use a different image for each ad"));
  fireEvent.click(screen.getByRole("button", { name: /Create with AI/ }));
  await screen.findByRole("button", { name: /New AI image/ });
  fireEvent.click(screen.getByRole("tab", { name: "Ad 2" }));
  fireEvent.click(screen.getByRole("tab", { name: "Ad 1" }));
  fireEvent.click(screen.getByRole("button", { name: /New AI image/ }));
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p.endsWith("/ad-image")).length).toBe(2));
  expect(JSON.parse(api.mock.calls.filter(([p]) => p.endsWith("/ad-image"))[1][1].body)).toMatchObject({ variation: 2 });
});
it("a changed description starts its versions over", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Create with AI/ }));
  await screen.findByRole("button", { name: /New AI image/ });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.change(screen.getByLabelText("What the picture shows"), { target: { value: "A sunny street with a parked car" } });
  fireEvent.click(screen.getByRole("button", { name: /New AI image/ }));
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p.endsWith("/ad-image")).length).toBe(2));
  expect(JSON.parse(api.mock.calls.filter(([p]) => p.endsWith("/ad-image"))[1][1].body)).toEqual({ prompt: "A sunny street with a parked car" });
});

it("a member keeps Review and create on a ChatGPT Ads draft, but not on a LinkedIn Ads one", () => {
  ws.role = "member";
  const view = render(<ChannelActionCard action={action} platform={chatgpt_ads} handlers={handlers()} />);
  expect(screen.getByRole("button", { name: "Review and create" })).toBeTruthy();
  view.unmount();
  const li = { ...action, id: "action-li", channel_slug: "linkedin_ads" } as ActionItem;
  const member = render(<ChannelActionCard action={li} platform={linkedin_ads} handlers={handlers()} />);
  expect(screen.queryByRole("button", { name: "Review and create" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy ad" })).toBeTruthy();
  member.unmount();
  ws.role = "owner";
  render(<ChannelActionCard action={li} platform={linkedin_ads} handlers={handlers()} />);
  expect(screen.getByRole("button", { name: "Review and create" })).toBeTruthy();
});

it("a draft that cannot be read says so and Try again reads it again", async () => {
  let fail = true;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) { if (fail) throw new Error("The request could not be completed. Refresh before trying again."); return review; }
    return path.startsWith("/api/chat/image-url") ? { signed_url: "https://storage.example/preview" } : { exact_change: { rows: [] } };
  });
  open();
  expect((await screen.findByRole("alert")).textContent).toContain("Zavi could not open this draft.");
  expect(screen.queryByText("Reading the saved creative…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create paused campaign" })).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Create paused campaign" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("ad-preview").textContent).toContain("Sponsored · client.example");
});

it("explains a conversion bid without promising a per-customer spending cap", async () => {
  review = reviewBody({ draft: { ...draft, bidding_type: "conversions", conversion_event_setting_ids: ["event-1"], ads: [ad("A", { image_url: "https://cdn.example/a.png" })] }, suggested: { ...suggested, max_bid_micros: null } });
  const { h } = open();
  const bid = await screen.findByLabelText("Bid for one customer action (USD)");
  expect(screen.getByText(/Billed per valid click, not per conversion/)).toBeTruthy();
  expect(screen.getByText(/No starter value is available/)).toBeTruthy();
  fireEvent.change(bid, { target: { value: "25" } });
  fireEvent.click(createButton());
  await waitFor(() => expect(h.onApprove).toHaveBeenCalledOnce());
  expect(prepareBody()).toMatchObject({ lifetime_budget_micros: 100_000_000, max_bid_micros: 25_000_000 });
});

it.each(["refused", "threw"])("keeps the saved draft visible when approval %s and prevents another prepare", async outcome => {
  review = reviewBody({ draft: { ...draft, ads: [ad("A", { image_url: "https://cdn.example/a.png" })] } });
  const h = handlers();
  if (outcome === "refused") h.onApprove.mockResolvedValue(false);
  else h.onApprove.mockRejectedValue(new Error("Network unavailable"));
  const { close, prepared } = open(h);
  await screen.findByLabelText("Spend up to, in total (USD)");
  fireEvent.click(createButton());
  await waitFor(() => expect(h.onApprove).toHaveBeenCalledOnce());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ id: action.id, executable: true }));
  expect(createButton().disabled).toBe(true);
  fireEvent.submit(document.querySelector("form")!);
  expect(api.mock.calls.filter(([p]) => p.endsWith("/prepare"))).toHaveLength(1);
  expect(h.onApprove).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Back to campaign card" }));
  expect(close).toHaveBeenCalledOnce();
});

it("lets the user retry preparation when saving the reviewed draft fails", async () => {
  review = reviewBody({ draft: { ...draft, ads: [ad("A", { image_url: "https://cdn.example/a.png" })] } });
  let saves = 0;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review;
    if (path.endsWith("/prepare") && ++saves === 1) throw new Error("Draft could not be saved");
    return { exact_change: { rows: [] } };
  });
  const { h, close } = open();
  await screen.findByLabelText("Spend up to, in total (USD)");
  fireEvent.click(createButton());
  await screen.findByRole("alert");
  expect(h.onApprove).not.toHaveBeenCalled();
  expect(createButton().disabled).toBe(false);
  fireEvent.click(createButton());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(saves).toBe(2);
  expect(h.onApprove).toHaveBeenCalledOnce();
});
