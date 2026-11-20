// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), trackEvent: vi.fn(), log: [] as string[] }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch, apiUrl: (p: string) => p }));
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: (event: string, props?: Record<string, unknown>) => {
    mocks.log.push(`track:${event}`);
    mocks.trackEvent(event, props);
  },
  trackEventDeferred: vi.fn(),
}));

import { UpgradePlanView } from "../UpgradePlanView";
import { PRICING_FALLBACK, type LivePricing } from "@/lib/marketing/pricing";
import type { SubscriptionState } from "@/lib/workspace/billingSubscription";

const PRICING: LivePricing = {
  ...PRICING_FALLBACK,
  sixMonthAvailable: true,
  tiers: PRICING_FALLBACK.tiers.map((t) =>
    t.slug === "starter"
      ? { ...t, usd: 27, sixMonthUsd: 93, sixMonthPerMonthUsd: 16 }
      : t.slug === "growth"
        ? { ...t, usd: 131, sixMonthUsd: 417, sixMonthPerMonthUsd: 70 }
        : t.slug === "pro"
          ? { ...t, usd: 1243, sixMonthUsd: 3721, sixMonthPerMonthUsd: 620 }
          : t,
  ),
};

const STRIPE = "https://checkout.stripe.test/s";

function stubLocation() {
  let href = "http://localhost/workspace";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(v: string) {
        mocks.log.push(`nav:${v}`);
        href = v;
      },
    },
  });
}

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const cta = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const eventsNamed = (name: string) => mocks.trackEvent.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.length = 0;
  stubLocation();
});
afterEach(cleanup);

describe("UpgradePlanView analytics: first purchase", () => {
  it.each([
    ["monthly", "starter", /^Start Starter$/, 27],
    ["monthly", "pro", /^Start Pro$/, 1243],
    ["6mo", "growth", /^Start Growth$/, 417],
    ["6mo", "pro", /^Start Pro$/, 3721],
  ] as const)("%s %s: one pricing_plan_selected, one checkout_started, both before the redirect", async (term, tier, btn, amount) => {
    mocks.apiFetch.mockResolvedValue(okJson({ url: STRIPE }));
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} />);
    if (term === "6mo") fireEvent.click(screen.getByRole("button", { name: /6 Months/ }));
    fireEvent.click(cta(btn));
    await vi.waitFor(() => expect(window.location.href).toBe(STRIPE));

    const props = { tier, term, amount_usd: amount, origin: "workspace", location: "in_app_upgrade" };
    expect(eventsNamed("pricing_plan_selected")).toEqual([["pricing_plan_selected", props]]);
    expect(eventsNamed("checkout_started")).toEqual([["checkout_started", { ...props, flow: "checkout" }]]);
    expect(mocks.trackEvent).toHaveBeenCalledTimes(2);
    expect(mocks.log).toEqual(["track:pricing_plan_selected", "track:checkout_started", `nav:${STRIPE}`]);
    expect(JSON.parse((mocks.apiFetch.mock.calls[0][1] as { body: string }).body)).toMatchObject({ tier, term });
  });

  it("names the tenant the plan was picked for", async () => {
    mocks.apiFetch.mockResolvedValue(okJson({ url: STRIPE }));
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} tenantId="tenant-1" />);
    fireEvent.click(cta(/^Start Growth$/));
    await vi.waitFor(() => expect(window.location.href).toBe(STRIPE));
    expect(eventsNamed("pricing_plan_selected")[0][1]).toMatchObject({ location: "in_app_upgrade", tenant_id: "tenant-1" });
  });

  it("switching the term back to monthly before clicking reports the monthly amount, not the six-month one", async () => {
    mocks.apiFetch.mockResolvedValue(okJson({ url: STRIPE }));
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} initialTerm="6mo" />);
    fireEvent.click(screen.getByRole("button", { name: /^Monthly$/ }));
    fireEvent.click(cta(/^Start Growth$/));
    await vi.waitFor(() => expect(window.location.href).toBe(STRIPE));
    expect(eventsNamed("pricing_plan_selected")).toEqual([
      ["pricing_plan_selected", { tier: "growth", term: "monthly", amount_usd: 131, origin: "workspace", location: "in_app_upgrade" }],
    ]);
  });

  it("a refused checkout records the pick but never checkout_started, and does not navigate", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "price_not_configured" } }),
    });
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} initialTerm="6mo" />);
    fireEvent.click(cta(/^Start Pro$/));
    await screen.findByRole("alert");
    expect(eventsNamed("pricing_plan_selected")).toHaveLength(1);
    expect(eventsNamed("checkout_started")).toHaveLength(0);
    expect(mocks.log.some((l) => l.startsWith("nav:"))).toBe(false);
  });

  it("a network failure never reports checkout_started", async () => {
    mocks.apiFetch.mockRejectedValue(new Error("offline"));
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} />);
    fireEvent.click(cta(/^Start Pro$/));
    await screen.findByRole("alert");
    expect(eventsNamed("checkout_started")).toHaveLength(0);
  });

  it("a double click while the first request is in flight still fires each event once", async () => {
    let resolve!: (v: unknown) => void;
    mocks.apiFetch.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<UpgradePlanView onBack={() => {}} currentTier="free" pricing={PRICING} />);
    const btn = cta(/^Start Growth$/);
    fireEvent.click(btn);
    fireEvent.click(btn);
    resolve(okJson({ url: STRIPE }));
    await vi.waitFor(() => expect(window.location.href).toBe(STRIPE));
    expect(eventsNamed("pricing_plan_selected")).toHaveLength(1);
    expect(eventsNamed("checkout_started")).toHaveLength(1);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("the billing Portal is reported as billing_portal_opened, not checkout_started", async () => {
    mocks.apiFetch.mockResolvedValue(okJson({ url: "https://billing.stripe.test/portal" }));
    render(<UpgradePlanView onBack={() => {}} currentTier="starter" manageViaPortal pricing={PRICING} />);
    fireEvent.click(cta(/^Start Pro$/));
    await vi.waitFor(() => expect(window.location.href).toBe("https://billing.stripe.test/portal"));
    expect(eventsNamed("checkout_started")).toHaveLength(0);
    expect(eventsNamed("billing_portal_opened")).toHaveLength(1);
  });

  it("the current plan and plans below it fire nothing", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" pricing={PRICING} />);
    fireEvent.click(cta(/^Current Plan$/));
    fireEvent.click(cta(/^Start Starter$/));
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});

describe("UpgradePlanView analytics: existing subscriber", () => {
  const growth: SubscriptionState = {
    tier: "growth",
    term: "monthly",
    status: "active",
    currentPeriodEnd: "2026-10-22T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
  };

  it("an upgrade fires pricing_plan_selected then checkout_started, before leaving for Stripe", async () => {
    const confirm = "https://billing.stripe.test/confirm";
    mocks.apiFetch.mockResolvedValue(okJson({ ok: true, kind: "upgrade", redirect: confirm }));
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} pricing={PRICING} />);
    fireEvent.click(screen.getByRole("button", { name: /6 Months/ }));
    fireEvent.click(cta(/^Upgrade to Pro$/));
    await vi.waitFor(() => expect(window.location.href).toBe(confirm));
    const props = { tier: "pro", term: "6mo", amount_usd: 3721, origin: "workspace", location: "in_app_upgrade" };
    expect(eventsNamed("pricing_plan_selected")).toEqual([["pricing_plan_selected", props]]);
    expect(eventsNamed("checkout_started")).toEqual([["checkout_started", { ...props, flow: "change_plan" }]]);
    expect(mocks.log).toEqual(["track:pricing_plan_selected", "track:checkout_started", `nav:${confirm}`]);
  });

  it("a downgrade records the pick once when chosen, not again on confirm, and never checkout_started", async () => {
    mocks.apiFetch.mockResolvedValue(
      okJson({
        ok: true,
        kind: "downgrade",
        subscription: {
          tier: "growth",
          term: "monthly",
          status: "active",
          current_period_end: growth.currentPeriodEnd,
          cancel_at_period_end: false,
          scheduled_change: { tier: "starter", term: "monthly", effective_at: growth.currentPeriodEnd },
        },
      }),
    );
    const onChange = vi.fn();
    render(
      <UpgradePlanView
        onBack={() => {}}
        currentTier="growth"
        subscription={growth}
        pricing={PRICING}
        onSubscriptionChange={onChange}
      />,
    );
    fireEvent.click(cta(/^Downgrade to Starter$/));
    expect(eventsNamed("pricing_plan_selected")).toEqual([
      ["pricing_plan_selected", { tier: "starter", term: "monthly", amount_usd: 27, origin: "workspace", location: "in_app_upgrade" }],
    ]);
    const dialog = screen.getByRole("dialog");
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Downgrade to Starter")!;
    fireEvent.click(confirmBtn);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(eventsNamed("pricing_plan_selected")).toHaveLength(1);
    expect(eventsNamed("checkout_started")).toHaveLength(0);
  });

  it("a downgrade to Free reports a monthly $0, whatever term the toggle shows", () => {
    render(<UpgradePlanView onBack={() => {}} currentTier="growth" subscription={growth} pricing={PRICING} initialTerm="6mo" />);
    fireEvent.click(cta(/^Downgrade to Free$/));
    expect(eventsNamed("pricing_plan_selected")).toEqual([
      ["pricing_plan_selected", { tier: "free", term: "monthly", amount_usd: 0, origin: "workspace", location: "in_app_upgrade" }],
    ]);
  });
});
