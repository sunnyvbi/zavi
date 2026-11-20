// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./WorkspaceShell", () => ({ useWorkspace: () => ({ role: "owner" }) }));
vi.mock("@/lib/workspace/planCheckout", () => ({ startPlanCheckout: vi.fn(async () => null) }));
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return {
    ...real,
    fetchLivePricingClient: async () => ({
      ...real.PRICING_FALLBACK,
      sixMonthAvailable: true,
      tiers: real.PRICING_FALLBACK.tiers.map((t) => (t.slug === "starter" ? { ...t, usd: 25 } : t)),
    }),
  };
});

import { PlanUpgradeDialog } from "./PlanUpgradeDialog";

afterEach(cleanup);

describe("PlanUpgradeDialog", () => {
  it("leads with the waiting work in one short headline, one line, one button", async () => {
    render(
      <PlanUpgradeDialog
        feature="SEO"
        tier="starter"
        work={{ total: 14, channels: 6, company: "Acme Bikes", clicked: { name: "SEO", count: 3 } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("14 actions ready for you")).toBeTruthy();
    expect(screen.getByText("Upgrade to Starter to see them.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See them" })).toBeTruthy();
    expect(screen.queryByText(/is on the Starter plan/)).toBeNull();
  });

  it("says one action, not one actions", () => {
    render(<PlanUpgradeDialog feature="SEO" tier="starter" work={{ total: 1, channels: 1, company: null }} onClose={() => {}} />);
    expect(screen.getByText("1 action ready for you")).toBeTruthy();
  });

  it("Upgrade opens the plan picker with this plan on six months, not a checkout", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
    render(<PlanUpgradeDialog feature="SEO" tier="pro" onClose={() => {}} />);
    await vi.waitFor(() => screen.getByRole("button", { name: /^6 months$/ }));
    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
    expect(assign).toHaveBeenCalledWith("/workspace?tab=settings#billing-upgrade-pro-6mo");
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  it("with nothing waiting names the feature, and the monthly charge is the live price", async () => {
    render(<PlanUpgradeDialog feature="SEO" tier="starter" onClose={() => {}} />);
    expect(screen.getByText("SEO is on the Starter plan")).toBeTruthy();
    expect(screen.getByText("Upgrade to Starter to open it.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Monthly" }));
    await screen.findByText("$25 billed today, then $25 every month");
    expect(screen.getByRole("button", { name: "Upgrade to Starter" })).toBeTruthy();
    expect(screen.queryByText("Zavi already did the work")).toBeNull();
  });

  it("Not now has the same min-height tap target as the upgrade button", () => {
    render(<PlanUpgradeDialog feature="AI UGC Videos" tier="starter" onClose={() => {}} />);
    const minH = (el: HTMLElement) => el.className.split(/\s+/).find((c) => c.startsWith("min-h-"));
    const upgrade = screen.getByRole("button", { name: "Upgrade to Starter" });
    const notNow = screen.getByRole("button", { name: "Not now" });
    expect(minH(notNow)).toBe("min-h-10");
    expect(minH(notNow)).toBe(minH(upgrade));
  });
});
