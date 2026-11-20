// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LivePricing } from "@/lib/marketing/pricing";

const live = vi.hoisted(() => ({ next: null as null | Promise<LivePricing> }));
const track = vi.hoisted(() => vi.fn());

vi.mock("./WorkspaceShell", () => ({ useWorkspace: () => ({ role: "owner", tenantId: "tenant-1" }) }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: track }));
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...real, fetchLivePricingClient: () => live.next ?? Promise.resolve(real.PRICING_FALLBACK) };
});

import { PlanUpgradeDialog } from "./PlanUpgradeDialog";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";

const LIVE: LivePricing = {
  ...PRICING_FALLBACK,
  sixMonthAvailable: true,
  sixMonthMonths: 6,
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

const charge = () => screen.getByTestId("plan-upgrade-charge").textContent;
const term = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  live.next = Promise.resolve(LIVE);
  track.mockClear();
});
afterEach(() => {
  cleanup();
  live.next = null;
});

describe("PlanUpgradeDialog charge", () => {
  it.each([
    ["starter", "$93 billed today for 6 months ($16/mo)", "$27 billed today, then $27 every month"],
    ["growth", "$417 billed today for 6 months ($70/mo)", "$131 billed today, then $131 every month"],
    ["pro", "$3,721 billed today for 6 months ($620/mo)", "$1,243 billed today, then $1,243 every month"],
  ] as const)("%s: shows the up-front charge for the selected term and follows the toggle", async (tier, six, monthly) => {
    render(<PlanUpgradeDialog feature="SEO" tier={tier} onClose={() => {}} />);
    await vi.waitFor(() => expect(charge()).toBe(six));
    expect(term(/^6 months$/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(term(/^Monthly$/));
    expect(charge()).toBe(monthly);
    expect(term(/^Monthly$/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(term(/^6 months$/));
    expect(charge()).toBe(six);
    expect(document.body.textContent).not.toMatch(/a month/);
  });

  it("before any live read only the monthly charge is quoted (the fallback never offers six months)", () => {
    live.next = new Promise(() => {});
    render(<PlanUpgradeDialog feature="SEO" tier="growth" onClose={() => {}} />);
    const g = PRICING_FALLBACK.tiers.find((t) => t.slug === "growth")!;
    const nf = new Intl.NumberFormat("en-US");
    expect(charge()).toBe(`$${nf.format(g.usd)} billed today, then $${nf.format(g.usd)} every month`);
    expect(screen.queryByRole("button", { name: /^6 months$/ })).toBeNull();
  });

  it("when the live read lands with six months on sale, six months is offered and selected", async () => {
    let land!: (p: LivePricing) => void;
    live.next = new Promise((r) => (land = r));
    render(<PlanUpgradeDialog feature="SEO" tier="pro" onClose={() => {}} />);
    await act(async () => land(LIVE));
    expect(charge()).toBe("$3,721 billed today for 6 months ($620/mo)");
    fireEvent.click(term(/^Monthly$/));
    expect(charge()).toBe("$1,243 billed today, then $1,243 every month");
  });

  it("when the backend cannot sell six months, it is neither offered nor sent to the plan picker", async () => {
    live.next = Promise.resolve({ ...LIVE, sixMonthAvailable: false });
    const onGoToPlans = vi.fn();
    render(<PlanUpgradeDialog feature="SEO" tier="pro" onGoToPlans={onGoToPlans} onClose={() => {}} />);
    await act(async () => {});
    expect(charge()).toBe("$1,243 billed today, then $1,243 every month");
    expect(screen.queryByRole("button", { name: /^6 months$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(onGoToPlans).toHaveBeenCalledWith("monthly");
  });

  it("the work-led dialog also states the charge, and its button carries no stale monthly price", async () => {
    render(
      <PlanUpgradeDialog feature="SEO" tier="starter" work={{ total: 3, channels: 2, company: null }} onClose={() => {}} />,
    );
    await vi.waitFor(() => expect(charge()).toBe("$93 billed today for 6 months ($16/mo)"));
    expect(screen.getByRole("button", { name: "See them" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\/mo\b(?!\))/);
  });

  it("the term on screen is the term the plan picker opens on (in-place)", async () => {
    const onGoToPlans = vi.fn();
    render(<PlanUpgradeDialog feature="SEO" tier="pro" onGoToPlans={onGoToPlans} onClose={() => {}} />);
    await vi.waitFor(() => term(/^Monthly$/));
    fireEvent.click(term(/^Monthly$/));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(onGoToPlans).toHaveBeenCalledTimes(1);
    expect(onGoToPlans).toHaveBeenCalledWith("monthly");
  });

  it("clicking upgrade records a paywall plan click with the plan, term and tenant", async () => {
    render(<PlanUpgradeDialog feature="SEO" tier="growth" onGoToPlans={() => {}} onClose={() => {}} />);
    await vi.waitFor(() => term(/^6 months$/));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Growth" }));
    expect(track.mock.calls).toEqual([
      ["pricing_plan_selected", { tier: "growth", term: "6mo", location: "paywall", tenant_id: "tenant-1" }],
    ]);
  });

  it("the term on screen is the term the plan picker opens on (full navigation)", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
    try {
      render(<PlanUpgradeDialog feature="SEO" tier="growth" onClose={() => {}} />);
      await vi.waitFor(() => term(/^Monthly$/));
      fireEvent.click(term(/^Monthly$/));
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Growth" }));
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("/workspace?tab=settings#billing-upgrade-growth-monthly");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});
