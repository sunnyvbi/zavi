// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch, apiUrl: (p: string) => p }));

import { UpgradePlanModal } from "../BillingCreditsPanel";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ url: "https://checkout.stripe.test/s" }),
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "http://localhost/workspace" },
  });
});
afterEach(cleanup);

const tierRadio = (name: RegExp) =>
  screen.getAllByRole("radio").find((el) => name.test(el.textContent ?? "")) as HTMLButtonElement;

describe("upgrade modal", () => {
  it("free tenant: opens on Starter and posts {tier}", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="free" />);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Starter" }));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/checkout");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ tier: "starter", origin: "workspace" });
  });

  it("shows prices and credits from the pricing it is handed", () => {
    const pricing = {
      ...PRICING_FALLBACK,
      tiers: PRICING_FALLBACK.tiers.map((t) =>
        t.slug === "growth" ? { ...t, includes: ["Everything in Starter", "50,000 credits a month plus 1,000 a day"] } : t,
      ),
    };
    render(<UpgradePlanModal onClose={() => {}} currentTier="free" pricing={pricing} />);
    expect(tierRadio(/Growth/).textContent).toContain("$120");
    expect(tierRadio(/Growth/).textContent).toContain("50,000 credits a month");
  });

  it("growth tenant: Starter and Growth are not selectable, default is Pro", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="growth" />);
    expect(tierRadio(/Starter/).disabled).toBe(true);
    expect(tierRadio(/Growth/).disabled).toBe(true);
    fireEvent.click(tierRadio(/Starter/));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).toEqual({ tier: "pro", origin: "workspace" });
  });

  it("pro tenant (not subscribed via Stripe): no checkout button at all", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="pro" />);
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });

  it("subscriber: hides the picker and opens the Portal via the portal route", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="starter" manageViaPortal />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open billing portal" }));
    expect(mocks.apiFetch.mock.calls[0][0]).toBe("/api/billing/portal");
  });

  it("legacy subscriber with no tier (currentTier free) still opens the Portal, never posts tier free", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="free" manageViaPortal />);
    fireEvent.click(screen.getByRole("button", { name: "Open billing portal" }));
    expect(mocks.apiFetch.mock.calls[0][0]).toBe("/api/billing/portal");
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).not.toHaveProperty("tier");
  });

  it("503 shows product copy, not the raw route message", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "billing_not_configured", message: "STRIPE_SECRET_KEY missing" } }),
    });
    render(<UpgradePlanModal onClose={() => {}} currentTier="free" />);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Starter" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/isn't available yet/);
    expect(alert.textContent).not.toMatch(/STRIPE/);
  });
});

describe("credit pack modal", () => {
  it("lists the three packs and posts the dollar amount, never diverted to the Portal", () => {
    render(<UpgradePlanModal onClose={() => {}} currentTier="starter" manageViaPortal purchase="topup" />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    fireEvent.click(tierRadio(/48,000 credits/));
    fireEvent.click(screen.getByRole("button", { name: "Buy credits" }));
    expect(mocks.apiFetch.mock.calls[0][0]).toBe("/api/billing/topup");
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).toEqual({ usd: 120 });
  });
});
