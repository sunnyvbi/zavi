// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch, apiUrl: (p: string) => p }));

import { UpgradePlanView } from "../UpgradePlanView";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";
import type { SubscriptionState } from "@/lib/workspace/billingSubscription";

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

const cta = (name: RegExp) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("upgrade plan page", () => {
  it("every paid card still states its credits on the six-month term", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="free" />);
    fireEvent.click(screen.getByRole("button", { name: /6 Months/ }));
    const body = document.body.textContent || "";
    expect(body).toContain("8,000");
    expect(body).toContain("48,000");
    expect(body).toContain("96,000");
  });

  it("free tenant: Start Growth posts {tier} to checkout", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="free" />);
    fireEvent.click(cta(/^Start Growth$/));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/checkout");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      tier: "growth",
      term: "monthly",
      origin: "workspace",
    });
  });

  it("an existing subscriber goes to the Portal, with no tier posted", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="starter" manageViaPortal />);
    fireEvent.click(cta(/^Start Pro$/));
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/portal");
    expect(JSON.parse((init as { body: string }).body)).toEqual({});
  });

  it("the tenant's own tier reads Current Plan, and nothing below it is startable", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" />);
    expect(cta(/^Current Plan$/).disabled).toBe(true);
    expect(cta(/^Start Starter$/).disabled).toBe(true);
    expect(cta(/^Start Pro$/).disabled).toBe(false);
    fireEvent.click(cta(/^Start Starter$/));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("prices and credit lines come from the pricing it is handed", () => {
    const pricing = {
      ...PRICING_FALLBACK,
      tiers: PRICING_FALLBACK.tiers.map((t) =>
        t.slug === "growth" ? { ...t, usd: 99, monthlyCredits: 50_000 } : t,
      ),
    };
    const { container } = render(
      <UpgradePlanView onBack={() => {}} currentTier="free" pricing={pricing} />,
    );
    const growth = container.querySelector('[data-tier="growth"]') as HTMLElement;
    expect(growth.textContent).toContain("99");
    expect(growth.textContent).toContain("50,000 credits monthly");
  });

  const withSixMonth = (available: boolean) => ({
    ...PRICING_FALLBACK,
    sixMonthAvailable: available,
  });

  it("always offers both terms, whatever the backend reports about six months", () => {
    const { unmount } = render(
      <UpgradePlanView onBack={() => {}} currentTier="free" pricing={withSixMonth(false)} />,
    );
    expect(screen.getByRole("group", { name: "Billing period" })).toBeTruthy();
    expect(cta(/6 Months/).getAttribute("aria-disabled")).toBeNull();
    unmount();

    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={withSixMonth(true)} />);
    expect(cta(/6 Months/).getAttribute("aria-disabled")).toBeNull();
  });

  it("switching to six months quotes half the monthly price, and charges that term", () => {
    const { container } = render(
      <UpgradePlanView onBack={() => {}} currentTier="free" pricing={withSixMonth(true)} />,
    );
    fireEvent.click(cta(/6 Months/));
    const growth = container.querySelector('[data-tier="growth"]') as HTMLElement;
    expect(growth.textContent).toContain("60/mo");
    expect(growth.querySelector("del")?.textContent).toContain("120");
    expect(growth.textContent).toContain("Save $360");
    expect(growth.textContent).toContain("$360 billed every 6 months");

    fireEvent.click(cta(/^Start Growth$/));
    const [, init] = mocks.apiFetch.mock.calls[0];
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      tier: "growth",
      term: "6mo",
      origin: "workspace",
    });
  });

  it("Free keeps its monthly $0 on the six-month term", () => {
    const { container } = render(
      <UpgradePlanView onBack={() => {}} currentTier="free" pricing={withSixMonth(true)} />,
    );
    fireEvent.click(cta(/6 Months/));
    const free = container.querySelector('[data-tier="free"]') as HTMLElement;
    expect(free.textContent).toContain("/mo");
    expect(free.querySelector("del")).toBeNull();
    expect(free.textContent).not.toContain("Save $");
  });

  it("a six-month refusal names the TERM, not the workspace's billing", async () => {
    for (const code of ["price_not_configured", "price_misconfigured"]) {
      cleanup();
      mocks.apiFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: { code, message: "no 6mo price for starter" } }),
      });
      render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={withSixMonth(true)} />);
      fireEvent.click(cta(/6 Months/));
      fireEvent.click(cta(/^Start Starter$/));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, code).toMatch(/six-month billing isn.t open yet/i);
      expect(alert.textContent, code).not.toMatch(/billing isn.t switched on/i);
    }
  });

  it("a 503 shows product copy, not the route's message", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "billing_not_configured", message: "stripe missing" } }),
    });
    render(<UpgradePlanView onBack={() => {}} currentTier="free" />);
    fireEvent.click(cta(/^Start Starter$/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/billing isn.t switched on/i);
  });
});

describe("existing subscriber: change plan", () => {
  const growth: SubscriptionState = {
    tier: "growth",
    term: "monthly",
    status: "active",
    currentPeriodEnd: "2026-10-22T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
  };

  it("draws no back arrow of its own unless asked (the shell's arrow steps back)", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} />);
    expect(screen.queryByRole("button", { name: /back to billing/i })).toBeNull();
  });

  it("offers every other plan, down as well as up", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} />);
    expect(cta(/^Current Plan$/).disabled).toBe(true);
    expect(cta(/^Upgrade to Pro$/).disabled).toBe(false);
    expect(cta(/^Downgrade to Starter$/).disabled).toBe(false);
    expect(cta(/^Downgrade to Free$/).disabled).toBe(false);
  });

  it("an upgrade posts {tier, term} to change-plan and follows the redirect", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, kind: "upgrade", redirect: "https://billing.stripe.test/confirm" }),
    });
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} />);
    fireEvent.click(cta(/^Upgrade to Pro$/));
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/change-plan");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ tier: "pro", term: "monthly" });
    await vi.waitFor(() => expect(window.location.href).toBe("https://billing.stripe.test/confirm"));
  });

  it("a refused upgrade shows its reason inside the card that was clicked", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "stripe_error", message: "Stripe said no." } }),
    });
    const { container } = render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} />);
    fireEvent.click(cta(/^Upgrade to Pro$/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Stripe said no.");
    expect(container.querySelector('[data-tier="pro"]')?.contains(alert)).toBe(true);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("a downgrade asks first, then schedules it and reports the new state", async () => {
    const scheduled = { ...growth, scheduled_change: { tier: "starter", term: "monthly", effective_at: growth.currentPeriodEnd } };
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        kind: "downgrade",
        subscription: { ...scheduled, current_period_end: growth.currentPeriodEnd, cancel_at_period_end: false },
      }),
    });
    const onChange = vi.fn();
    render(
      <UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} onSubscriptionChange={onChange} />,
    );
    fireEvent.click(cta(/^Downgrade to Starter$/));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/until Oct 22/);
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Downgrade to Starter")!;
    fireEvent.click(confirmBtn);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/change-plan");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ tier: "starter", term: "monthly" });
    expect(onChange.mock.calls[0][0]?.scheduledChange?.tier).toBe("starter");
  });

  it("a scheduled downgrade reads as pending, with a way to keep the plan", () => {
    render(
      <UpgradePlanView
        onBack={() => {}}
        currentTier="growth"
        subscription={{ ...growth, scheduledChange: { tier: "starter", term: "monthly", effectiveAt: growth.currentPeriodEnd } }}
      />,
    );
    expect(cta(/^Starts Oct 22$/).disabled).toBe(true);
    expect(screen.getByText(/Your plan changes to Starter on Oct 22/)).toBeTruthy();
    expect(cta(/^Keep Growth$/).disabled).toBe(false);
  });
});

describe("plan picked on /pricing", () => {
  it("opens on initialTerm and posts it with the tier only on click", () => {
    render(
      <UpgradePlanView onBack={() => {}} currentTier="free" initialTerm="6mo" pickedTier="growth" />,
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    const picked = document.querySelector('[data-tier="growth"]');
    expect(picked?.textContent).toContain("Your pick");
    expect(document.body.textContent).not.toContain("Recommended");
    fireEvent.click(cta(/^Start Growth$/));
    const [url, init] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe("/api/billing/checkout");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      tier: "growth",
      term: "6mo",
      origin: "workspace",
    });
  });

  it("without initialTerm still opens on monthly", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="free" />);
    fireEvent.click(cta(/^Start Starter$/));
    const [, init] = mocks.apiFetch.mock.calls[0];
    expect(JSON.parse((init as { body: string }).body).term).toBe("monthly");
  });
});

describe("store plan (App Store / Google Play)", () => {
  const storePlan: SubscriptionState = {
    tier: "growth",
    term: null,
    status: "active",
    currentPeriodEnd: "2026-10-22T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    source: "app_store",
  };

  it("shows the managed-in-store line, keeps Current Plan, and offers no buy or switch buttons", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={storePlan} />);
    expect(document.body.textContent).toContain(
      "Your plan is managed in the App Store or Google Play. Change or cancel it there.",
    );
    expect(cta(/^Current Plan$/).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^(Start|Upgrade to|Downgrade to|Switch to)/ })).toBeNull();
  });

  it("a 409 managed_in_store from checkout shows the backend message", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "managed_in_store", message: "Managed in the store." } }),
    });
    render(<UpgradePlanView onBack={() => {}} currentTier="free" />);
    fireEvent.click(cta(/^Start Growth$/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Managed in the store.");
  });
});
