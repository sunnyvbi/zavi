// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), campaignFetch: api }));
vi.mock("@/lib/stripe/adsStripe", () => ({ adsPublishableKey: () => null, adsStripe: () => null }));
import { ChannelBalance } from "./ChannelBalance";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const spec = chatgpt_ads.campaignWorkspace!;
let wallet: Record<string, unknown>;
const walletBase = { balance_cents: 0, reserved_cents: 0, available_cents: 0, funding_enabled: true, in_app_enabled: false, auto_refill_enabled: false, refill_cents: 5000, threshold_cents: 5000, pending: false, last_error: null };
const land = (query: string) => window.history.replaceState({}, "", `/workspace?tab=channels&channel=linkedin_ads${query}`);
beforeEach(() => {
  api.mockReset(); sessionStorage.clear(); wallet = { ...walletBase };
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.mockImplementation(async (path: string) => path.endsWith("/wallet/checkout") ? { url: "https://checkout.stripe.com/c/pay/x" } : wallet);
  land("");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const notice = async () => (await screen.findByTestId("ads-payment-notice")).textContent ?? "";
const stash = (v: object) => sessionStorage.setItem("zavi.adsCheckout", JSON.stringify(v));

it("after a card-only save the founder is told no money was added, with refill state, never that money arrived", async () => {
  stash({ mode: "setup", cents: 5000, refill: true });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  const text = await notice();
  expect(text).toMatch(/Card saved\. No money was added to your ads balance\./);
  expect(text).toMatch(/Auto-refill is on: Zavi charges this card \$50\.00 when your balance drops below/);
  expect(text).not.toMatch(/\$[\d.,]+ (was added to|is being added to)/);
  expect(screen.getByText("$0.00")).toBeTruthy();
});

it("a card save without refill says auto-refill is off", async () => {
  stash({ mode: "setup", cents: 5000, refill: false });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  expect(await notice()).toMatch(/No money was added[\s\S]*Auto-refill is off\./);
});

it("Add money now from the card-saved notice opens the dialog on Add once", async () => {
  stash({ mode: "setup", cents: 5000, refill: true });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  await notice();
  await waitFor(() => expect(screen.getByRole("button", { name: "Add money now" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Add money now" }));
  expect(screen.getByRole("button", { name: "Add once" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /^Pay / })).toBeTruthy();
  expect(screen.queryByTestId("ads-payment-notice")).toBeNull();
});

const orderReads = () => api.mock.calls.filter(([p]) => String(p).startsWith("/api/ads/wallet/orders/"));
const DECLINED = "Auto-refill was declined by your card. Add balance manually or set up auto-refill again with another card.";
function serve(order: { status: string }) {
  api.mockImplementation(async (path: string) => path.endsWith("/wallet/checkout") ? { url: "https://checkout.stripe.com/c/pay/x" } : path === "/api/ads/wallet/orders/o5" ? order : wallet);
}

it("after a one-time top-up the amount is only being added until the webhook credits it, and the card re-reads on its own until it lands", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const order = { status: "pending" };
    serve(order);
    stash({ mode: "topup", cents: 5000, refill: false, id: "o5" });
    land("&ads_payment=success");
    render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
    await waitFor(async () => expect(await notice()).toMatch(/\$50\.00 is being added to your ads balance\./));
    expect(await notice()).not.toMatch(/was added/);
    expect(screen.queryByRole("button", { name: "Add money now" })).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await notice()).toMatch(/is being added/);
    wallet = { ...walletBase, balance_cents: 5000, available_cents: 5000 };
    order.status = "paid";
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(async () => expect(await notice()).toMatch(/\$50\.00 was added to your ads balance\./));
    expect(screen.getByText("$50.00")).toBeTruthy();
    const reads = orderReads().length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(orderReads()).toHaveLength(reads);
  } finally { vi.useRealTimers(); }
});

it("the re-read is bounded: a credit that never lands stops polling and never claims the money arrived", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({ status: "pending" });
    stash({ mode: "topup", cents: 5000, id: "o5" });
    land("&ads_payment=success");
    render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
    await notice();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const reads = orderReads().length;
    expect(reads).toBeGreaterThan(3);
    expect(reads).toBeLessThanOrEqual(20);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(orderReads()).toHaveLength(reads);
    expect(await notice()).toMatch(/\$50\.00 is being added to your ads balance\./);
  } finally { vi.useRealTimers(); }
});

it("a top-up whose order the server marks failed says nothing was charged", async () => {
  serve({ status: "failed" });
  stash({ mode: "topup", cents: 5000, id: "o5" });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  await waitFor(async () => expect(await notice()).toMatch(/did not go through\. Nothing was charged\./));
});

it("a manual Checkout top-up that lands clears the auto-refill decline from the card, though the server still reports it", async () => {
  wallet = { ...walletBase, last_error: DECLINED };
  const order = { status: "pending" };
  serve(order);
  stash({ mode: "topup", cents: 5000, id: "o5" });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  expect((await screen.findByRole("alert")).textContent).toBe(DECLINED);
  order.status = "paid";
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 5000 });
  window.dispatchEvent(new Event("focus"));
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  wallet = { ...wallet, last_error: "A refill needs payment review. No further automatic charges will be attempted." };
  window.dispatchEvent(new Event("focus"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/needs payment review/);
});

it("a return with no remembered checkout claims nothing about money", async () => {
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  const text = await notice();
  expect(text).toMatch(/if you only saved a card, no money was added/);
  expect(text).not.toMatch(/was added to your ads balance|Card saved\./);
});

it("a cancelled checkout says nothing was charged", async () => {
  stash({ mode: "setup", cents: 5000, refill: true });
  land("&ads_payment=cancel");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  const text = await notice();
  expect(text).toMatch(/cancelled\. Nothing was charged/);
  expect(text).not.toMatch(/Card saved/);
});

it("the return flag is consumed from the URL and storage, so a reload does not repeat it, and the tile variant shows it too", async () => {
  stash({ mode: "setup", cents: 5000, refill: true });
  land("&ads_payment=success");
  const view = render(<ChannelBalance spec={spec} />);
  await notice();
  expect(window.location.search).toBe("?tab=channels&channel=linkedin_ads");
  expect(sessionStorage.getItem("zavi.adsCheckout")).toBeNull();
  view.unmount();
  render(<ChannelBalance spec={spec} />);
  await screen.findByText("Shared ads balance");
  expect(screen.queryByTestId("ads-payment-notice")).toBeNull();
});

it("the dialog-only variant leaves the return flag for the page that shows the notice", async () => {
  stash({ mode: "setup", cents: 5000, refill: true });
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} variant="dialog" onDialogClosed={() => undefined} />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(window.location.search).toContain("ads_payment=success");
  expect(screen.queryByTestId("ads-payment-notice")).toBeNull();
});

it("a stray ads_payment value is ignored", async () => {
  land("&ads_payment=evil");
  render(<ChannelBalance spec={spec} variant="card" />);
  await screen.findByText("Shared ads balance");
  expect(screen.queryByTestId("ads-payment-notice")).toBeNull();
  expect(window.location.search).toContain("ads_payment=evil");
});

it("saving a card remembers what the founder chose, and the return after that checkout reads it back", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const first = render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i }));
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "50" } });
  fireEvent.click(screen.getByLabelText(/Authorize Zavi to charge this card for LinkedIn ads refills/));
  fireEvent.click(screen.getByRole("button", { name: "Save card" }));
  await waitFor(() => expect(assign).toHaveBeenCalled());
  expect(JSON.parse(sessionStorage.getItem("zavi.adsCheckout")!)).toEqual({ mode: "setup", cents: 5000, refill: true, id: expect.any(String) });
  first.unmount(); vi.unstubAllGlobals();
  land("&ads_payment=success");
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  expect(await notice()).toMatch(/Card saved\. No money was added[\s\S]*Auto-refill is on/);
});

it("the Card tab says before submitting that it adds no money now and points to Add once", async () => {
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i }));
  const dialog = screen.getByRole("dialog", { hidden: true });
  expect(within(dialog).getByText(/does not add money to your ads balance now/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "switch to Add once" }));
  expect(within(dialog).getByRole("button", { name: "Add once" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(dialog).queryByText(/does not add money to your ads balance now/)).toBeNull();
});

it("$25 as a refill amount is refused with a pointer to Add once, and following it keeps the $25 and enables Pay", async () => {
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i }));
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "25" } });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toMatch(/Auto-refill amounts start at \$50\.00\. To add \$25\.00 now, switch to Add once/);
  expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(alert).getByRole("button", { name: "switch to Add once" }));
  expect((screen.getByLabelText("Amount in USD") as HTMLInputElement).value).toBe("25");
  expect((screen.getByRole("button", { name: "Pay $25.00" }) as HTMLButtonElement).disabled).toBe(false);
});

it("no under-minimum pointer when refill is off or the amount is valid", async () => {
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "50" } });
  expect(screen.queryByRole("alert")).toBeNull();
});
