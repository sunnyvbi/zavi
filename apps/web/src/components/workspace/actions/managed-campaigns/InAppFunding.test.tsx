// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
const key = vi.hoisted(() => ({ value: "pk_test_1" as string | null }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), campaignFetch: api }));
vi.mock("@/lib/stripe/adsStripe", () => ({ adsPublishableKey: () => key.value, adsStripe: () => null }));
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: { add: toastAdd } }));
import { ChannelBalance } from "./ChannelBalance";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const spec = chatgpt_ads.campaignWorkspace!;
const consent = { version: "v1", save_text: "Save this card.", refill_text: "Refill {amount}.", creator_text: "Creator hires." };
const cards = [
  { id: "pm_a", brand: "visa", last4: "5556", funding: "debit", exp_month: 1, exp_year: 2030, city: "San Francisco", state: "CA" },
  { id: "pm_b", brand: "visa", last4: "0003", funding: "credit", exp_month: 1, exp_year: 2030, city: "San Francisco", state: "NY" },
  { id: "pm_c", brand: "amex", last4: "0005", funding: "credit", exp_month: 1, exp_year: 2030, city: null, state: null },
];
let inApp = true;
beforeEach(() => {
  api.mockReset(); toastAdd.mockReset(); key.value = "pk_test_1"; inApp = true; localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/wallet")) return { balance_cents: 10000, reserved_cents: 0, available_cents: 10000, funding_enabled: true, in_app_enabled: inApp, auto_refill_enabled: false, refill_cents: 10000, threshold_cents: 5000, pending: false, last_error: null };
    if (path.endsWith("/wallet/payment-methods")) return { tenant_id: "t1", cards, selected_id: "pm_a", creator_consent: false, consent };
    if (path.endsWith("/wallet/pay")) return { order_id: "o1", status: "pending" };
    if (path.includes("/wallet/orders/")) return { order_id: "o1", status: "paid" };
    return {};
  });
});
afterEach(cleanup);
const openModal = async () => fireEvent.click(await screen.findByRole("button", { name: "+ Add balance" }));

it("shows saved cards with the selected one checked and the +N Saved count", async () => {
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByText("XXXX- 5556")).toBeTruthy();
  expect(screen.getByText("+2 Saved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("option", { selected: true }).textContent).toContain("5556");
  expect(screen.getByText("San Francisco, NY")).toBeTruthy();
});
it("pays with the selected card without re-consent and never redirects to Stripe", async () => {
  const assign = vi.fn(); Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
  render(<ChannelBalance spec={spec} />); await openModal();
  await screen.findByText("XXXX- 5556");
  expect(screen.queryByText("Save this card.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet/pay", expect.objectContaining({ method: "POST" })));
  const body = JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/wallet/pay"))![1].body);
  expect(body).toMatchObject({ amount_cents: 10000, payment_method_id: "pm_a" });
  await waitFor(() => expect(screen.queryByText("Amount to add")).toBeNull());
  expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Added $100", description: "ChatGPT Ads" }));
  await openModal(); await screen.findByText("XXXX- 5556");
  expect((screen.getByLabelText("Amount in USD") as HTMLInputElement).value).toBe("100");
  expect(assign).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([p]) => p.endsWith("/wallet/checkout"))).toBe(false);
});
it("keeps the Stripe Checkout flow when the server flag is off", async () => {
  inApp = false;
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByRole("button", { name: "Card" })).toBeTruthy();
  expect(api.mock.calls.some(([p]) => p.endsWith("/payment-methods"))).toBe(false);
});
it("keeps the Stripe Checkout flow when the build has no publishable key", async () => {
  key.value = null;
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByRole("button", { name: "Card" })).toBeTruthy();
  expect(screen.queryByText("Payment Method")).toBeNull();
});
const payIds = () => api.mock.calls.filter(([p]) => p.endsWith("/wallet/pay")).map(([, o]) => JSON.parse(o.body).request_id);
const payBodies = () => api.mock.calls.filter(([p]) => p.endsWith("/wallet/pay")).map(([, o]) => JSON.parse(o.body));
const orderReads = () => api.mock.calls.filter(([p]) => p.includes("/wallet/orders/"));
it("locks an ambiguous (5xx) payment: controls freeze and Check payment only asks the server, never charging again", async () => {
  const base = api.getMockImplementation()!;
  let order = "pending";
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/pay")) throw Object.assign(new Error("Gateway timeout"), { status: 502 }); if (path.includes("/wallet/orders/")) return { status: order }; return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" })); await screen.findByText("Gateway timeout");
  const check = await screen.findByRole("button", { name: "Check payment" });
  expect((screen.getByRole("button", { name: "$250" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Amount in USD") as HTMLInputElement).disabled).toBe(true);
  const reads = orderReads().length;
  fireEvent.click(check); await waitFor(() => expect(orderReads().length).toBe(reads + 1));
  expect(await screen.findByText(/still being confirmed/)).toBeTruthy();
  expect(payIds()).toHaveLength(1);
  order = "paid";
  fireEvent.click(await screen.findByRole("button", { name: "Check payment" }));
  await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ description: "ChatGPT Ads" })));
  expect(payIds()).toHaveLength(1);
});
it("frees the lock only when the server says the order failed, then starts a new request", async () => {
  const base = api.getMockImplementation()!;
  let order = "failed";
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/pay")) throw Object.assign(new Error("Your card was declined. Nothing was charged."), { status: 402 }); if (path.includes("/wallet/orders/")) return { status: order }; return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" })); await screen.findByText(/declined/);
  fireEvent.click(await screen.findByRole("button", { name: "Pay $100.00" })); await waitFor(() => expect(payIds()).toHaveLength(2));
  expect(payIds()[1]).not.toBe(payIds()[0]);
  order = "pending";
  fireEvent.click(await screen.findByRole("button", { name: /Pay|Check/ }));
  expect(await screen.findByRole("button", { name: "Check payment" })).toBeTruthy();
});
it("keeps the 3DS error and does not report processing when a payment still needs authentication", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/pay") ? { order_id: "o1", status: "pending" } : path.includes("/wallet/orders/") ? { order_id: "o1", status: "requires_action" } : base(path, o));
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
  expect(await screen.findByText(/bank needs you to confirm/)).toBeTruthy();
  expect(screen.queryByText(/processing/)).toBeNull();
});
it("keeps an unresolved payment across a closed dialog and pays it with the original amount and card", async () => {
  localStorage.setItem("zavi.adsPay.t1./api/channels/chatgpt_ads", JSON.stringify({ signature: "pay", id: "o9", amount: "250", card: "pm_b" }));
  const base = api.getMockImplementation()!;
  let status = "pending";
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/orders/o9") ? { order_id: "o9", status } : base(path, o));
  const view = render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByText(/payment of \$250 is still being confirmed/)).toBeTruthy();
  expect(screen.getByText("XXXX- 0003")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check payment" }));
  await waitFor(() => expect(orderReads()).toHaveLength(2));
  expect(payBodies()).toHaveLength(0);
  status = "requires_action";
  fireEvent.click(await screen.findByRole("button", { name: "Check payment" }));
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(payBodies()[0]).toMatchObject({ request_id: "o9", amount_cents: 25000, payment_method_id: "pm_b" });
  view.unmount(); status = "paid";
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  await waitFor(() => expect(localStorage.getItem("zavi.adsPay.t1./api/channels/chatgpt_ads")).toBeNull());
  expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Added $250", description: "ChatGPT Ads" }));
  expect(await screen.findByRole("button", { name: "Pay $100.00" })).toBeTruthy();
});
it("does not pick up another workspace's unresolved payment", async () => {
  localStorage.setItem("zavi.adsPay.t2./api/channels/chatgpt_ads", JSON.stringify({ signature: "pay", id: "o7", amount: "250", card: "pm_b" }));
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  expect(await screen.findByRole("button", { name: "Pay $100.00" })).toBeTruthy();
  expect(api.mock.calls.some(([p]) => p.endsWith("/orders/o7"))).toBe(false);
  expect(localStorage.getItem("zavi.adsPay.t2./api/channels/chatgpt_ads")).not.toBeNull();
});
it("a 404 after an ambiguous failure keeps the same request (the first may still be running) but offers Pay, not Check payment", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/pay")) throw Object.assign(new Error("Gateway timeout"), { status: 504 }); if (path.includes("/wallet/orders/")) throw Object.assign(new Error("Not found"), { status: 404 }); return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" })); await screen.findByText("Gateway timeout");
  const pay = await screen.findByRole("button", { name: "Pay $100.00" });
  expect(screen.queryByRole("button", { name: "Check payment" })).toBeNull();
  expect((screen.getByLabelText("Amount in USD") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(pay); await waitFor(() => expect(payIds()).toHaveLength(2));
  expect(payIds()[1]).toBe(payIds()[0]);
});
it("reopening after a payment that never reached the server says so, never 'being confirmed', and no Check payment press can charge", async () => {
  localStorage.setItem("zavi.adsPay.t1./api/channels/chatgpt_ads", JSON.stringify({ signature: "pay", id: "o8", amount: "250", card: "pm_b" }));
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/orders/o8")) throw Object.assign(new Error("Not found"), { status: 404 }); return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByText(/no record of your earlier payment of \$250, so you have not been charged/)).toBeTruthy();
  expect(screen.queryByText(/being confirmed/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Check payment" })).toBeNull();
  expect(payBodies()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Pay $250.00" }));
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(payBodies()[0]).toMatchObject({ request_id: "o8", amount_cents: 25000, payment_method_id: "pm_b" });
});
it("a known pending payment that the server later loses turns Check payment into Pay without charging on the check", async () => {
  localStorage.setItem("zavi.adsPay.t1./api/channels/chatgpt_ads", JSON.stringify({ signature: "pay", id: "o9", amount: "250", card: "pm_b" }));
  const base = api.getMockImplementation()!;
  let gone = false;
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/orders/o9")) { if (gone) throw Object.assign(new Error("Not found"), { status: 404 }); return { order_id: "o9", status: "pending" }; } return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal();
  await screen.findByText(/still being confirmed/);
  gone = true;
  fireEvent.click(screen.getByRole("button", { name: "Check payment" }));
  expect(await screen.findByRole("button", { name: "Pay $250.00" })).toBeTruthy();
  expect(screen.getByText(/no record of your earlier payment/)).toBeTruthy();
  expect(payBodies()).toHaveLength(0);
});
it("a manual in-app top-up that succeeds clears the auto-refill decline from the wallet card", async () => {
  const DECLINED = "Auto-refill was declined by your card. Add balance manually or set up auto-refill again with another card.";
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet") ? { ...(await base(path, o)), last_error: DECLINED } : base(path, o));
  render(<ChannelBalance spec={spec} variant="card" />);
  expect((await screen.findByRole("alert")).textContent).toBe(DECLINED);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i })); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
  await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ description: "ChatGPT Ads" })));
  await waitFor(() => expect(screen.queryByText(DECLINED)).toBeNull());
  window.dispatchEvent(new Event("focus"));
  await new Promise(r => setTimeout(r, 50));
  expect(screen.queryByText(DECLINED)).toBeNull();
});
const selectBodies = () => api.mock.calls.filter(([p]) => p.endsWith("/payment-methods/select")).map(([, o]) => JSON.parse(o.body));
it("ticking auto-refill shows the refill note, and Pay saves refill at the saved refill amount, not the one-off amount, before charging", async () => {
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  expect(screen.queryByText(/When your ads balance drops below/)).toBeNull();
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "250" } });
  expect(screen.getByText(/When your ads balance drops below \$50\.00, Zavi charges \$100\.00 to your saved card\. The daily limit is \$1,000\.00/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pay $250.00" }));
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(payBodies()[0]).toMatchObject({ amount_cents: 25000 });
  expect(selectBodies()).toEqual([expect.objectContaining({ payment_method_id: "pm_a", enable_refill: true, amount_cents: 10000, allow_creators: false, consent: true, consent_version: "v1" })]);
  const order = api.mock.calls.map(([p]) => p).filter(p => p.endsWith("/select") || p.endsWith("/wallet/pay"));
  expect(order).toEqual(["/api/ads/wallet/payment-methods/select", "/api/ads/wallet/pay"]);
});
const refillWallet = (state: { on: boolean }) => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet") ? { ...(await base(path, o)), auto_refill_enabled: state.on, refill_cents: 10000 } : base(path, o));
};
it.each(["250", "20", "1500"])("a one-off $%s top-up with auto-refill on never rewrites the auto-refill amount, card or switch", async (value) => {
  refillWallet({ on: true });
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  expect((screen.getByLabelText("Also auto-refill my ads balance") as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value } });
  expect(screen.queryByText(/amount must be between/)).toBeNull();
  expect(screen.queryByText(/smaller amount/)).toBeNull();
  expect(screen.getByText(/Zavi charges \$100\.00 to your saved card/)).toBeTruthy();
  const pay = screen.getByRole("button", { name: /^Pay / }) as HTMLButtonElement;
  expect(pay.disabled).toBe(false);
  fireEvent.click(pay);
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(payBodies()[0]).toMatchObject({ amount_cents: Math.round(Number(value) * 100), payment_method_id: "pm_a" });
  expect(selectBodies()).toEqual([]);
});
it("a failed one-off payment leaves auto-refill exactly as it was", async () => {
  refillWallet({ on: true });
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/pay") ? { order_id: "o1", status: "failed" } : base(path, o));
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.change(screen.getByLabelText("Amount in USD"), { target: { value: "300" } });
  fireEvent.click(screen.getByRole("button", { name: "Pay $300.00" }));
  expect(await screen.findByText(/did not go through/)).toBeTruthy();
  expect(selectBodies()).toEqual([]);
});
it("paying from a dialog opened before auto-refill was switched off elsewhere never switches it back on", async () => {
  const state = { on: true };
  refillWallet(state);
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  expect((screen.getByLabelText("Also auto-refill my ads balance") as HTMLInputElement).checked).toBe(true);
  state.on = false;
  const walletReads = () => api.mock.calls.filter(([p]) => p.endsWith("/wallet")).length;
  const before = walletReads();
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(walletReads()).toBeGreaterThan(before));
  await waitFor(() => expect((screen.getByLabelText("Also auto-refill my ads balance") as HTMLInputElement).checked).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(selectBodies().filter(b => b.enable_refill === true)).toEqual([]);
  expect(selectBodies()).toEqual([]);
});
it("creator box shows the saved consent of the wallet card, resets when switching card, and switching saves the card before paying", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/payment-methods") ? { tenant_id: "t1", cards, selected_id: "pm_a", creator_consent: true, consent } : base(path, o));
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  const creator = () => screen.getByLabelText(/Authorize Zavi to charge this card for creator hires/) as HTMLInputElement;
  expect(creator().checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  fireEvent.click(screen.getByRole("option", { name: /0003/ }).querySelector("button")!);
  expect(creator().checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
  await waitFor(() => expect(payBodies()).toHaveLength(1));
  expect(selectBodies()[0]).toMatchObject({ payment_method_id: "pm_b", allow_creators: false, enable_refill: false });
  expect(payBodies()[0]).toMatchObject({ payment_method_id: "pm_b" });
});
it("has no tab switcher and no extra consent boxes (Figma single screen)", async () => {
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByText("Save this card.")).toBeNull();
  expect(screen.getByText(/After payment, your ads balance will be \$200\.00\. Ad spend is separate from your Zavi credits\./)).toBeTruthy();
});
it("keeps an unresolved payment visible to other tabs (shared storage)", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => { if (path.endsWith("/wallet/pay")) throw Object.assign(new Error("Gateway timeout"), { status: 502 }); if (path.includes("/wallet/orders/")) return { status: "pending" }; return base(path, o); });
  render(<ChannelBalance spec={spec} />); await openModal(); await screen.findByText("XXXX- 5556");
  fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" })); await screen.findByText("Gateway timeout");
  expect(JSON.parse(window.localStorage.getItem("zavi.adsPay.t1./api/channels/chatgpt_ads")!)).toMatchObject({ id: payIds()[0] });
  expect(window.sessionStorage.getItem("zavi.adsPay.t1./api/channels/chatgpt_ads")).toBeNull();
});
it("a restored pending card that is not the wallet card starts with the creator box unticked", async () => {
  localStorage.setItem("zavi.adsPay.t1./api/channels/chatgpt_ads", JSON.stringify({ signature: "pay", id: "o9", amount: "250", card: "pm_b" }));
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/payment-methods") ? { tenant_id: "t1", cards, selected_id: "pm_a", creator_consent: true, consent } : path.endsWith("/wallet/orders/o9") ? { order_id: "o9", status: "pending" } : base(path, o));
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByText(/payment of \$250 is still being confirmed/)).toBeTruthy();
  expect(screen.getByText("XXXX- 0003")).toBeTruthy();
  expect((screen.getByLabelText(/Authorize Zavi to charge this card for creator hires/) as HTMLInputElement).checked).toBe(false);
});

it("on the LinkedIn page the refill authorization names LinkedIn Ads, and that is what the founder submits", async () => {
  inApp = false;
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/checkout") ? { url: "https://checkout.stripe.com/c/pay/x" } : base(path, o));
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add balance/i }));
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  const consentBox = screen.getByLabelText(/Authorize Zavi to charge this card for LinkedIn ads refills/);
  expect(consentBox.closest("label")!.textContent).toMatch(/Disable auto-refill in the LinkedIn Ads channel at any time\./);
  expect(document.body.textContent).not.toMatch(/ChatGPT/);
  fireEvent.click(consentBox);
  fireEvent.click(screen.getByRole("button", { name: "Save card" }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/x"));
  const [, init] = api.mock.calls.find(([p]) => p === "/api/ads/wallet/checkout")!;
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ mode: "setup", consent: true, enable_refill: true, platform: "linkedin" });
  vi.unstubAllGlobals();
});

it("on the ChatGPT page the refill authorization still names ChatGPT Ads", async () => {
  inApp = false;
  render(<ChannelBalance spec={spec} />); await openModal();
  fireEvent.click(screen.getByLabelText("Also auto-refill my ads balance"));
  const label = screen.getByLabelText(/Authorize Zavi to charge this card for ChatGPT ads refills/).closest("label")!;
  expect(label.textContent).toMatch(/Disable auto-refill in the ChatGPT Ads channel at any time\./);
  expect(label.textContent).not.toMatch(/LinkedIn/);
});

it("a ChatGPT checkout sends exactly the old body, with no platform", async () => {
  inApp = false;
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path.endsWith("/wallet/checkout") ? { url: "https://checkout.stripe.com/c/pay/y" } : base(path, o));
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  render(<ChannelBalance spec={spec} />); await openModal();
  fireEvent.click(screen.getByRole("button", { name: "Add once" }));
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await waitFor(() => expect(assign).toHaveBeenCalled());
  const [path, init] = api.mock.calls.find(([p]) => p === "/api/ads/wallet/checkout")!;
  expect(path).toBe("/api/ads/wallet/checkout");
  const body = JSON.parse((init as RequestInit).body as string);
  expect(Object.keys(body)).toEqual(["mode", "amount_cents", "consent", "request_id"]);
  vi.unstubAllGlobals();
});

it("saved cards on the LinkedIn page are read for LinkedIn, and LinkedIn's wording is shown", async () => {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, o?: RequestInit) => path === "/api/ads/wallet/payment-methods?platform=linkedin" ? { tenant_id: "t1", cards, selected_id: "pm_a", creator_consent: false, consent: { ...consent, save_text: "Save this card for LinkedIn ads." } } : base(path, o));
  render(<ChannelBalance spec={spec} platform="linkedin" />); await openModal();
  expect(await screen.findByText("XXXX- 5556")).toBeTruthy();
  const listed = api.mock.calls.map(([p]) => p).filter(p => String(p).includes("/wallet/payment-methods"));
  expect(listed).toEqual(["/api/ads/wallet/payment-methods?platform=linkedin"]);
});

it("saved cards on the ChatGPT page are read without a platform", async () => {
  render(<ChannelBalance spec={spec} />); await openModal();
  expect(await screen.findByText("XXXX- 5556")).toBeTruthy();
  const listed = api.mock.calls.map(([p]) => p).filter(p => String(p).includes("/wallet/payment-methods"));
  expect(listed).toEqual(["/api/ads/wallet/payment-methods"]);
});
