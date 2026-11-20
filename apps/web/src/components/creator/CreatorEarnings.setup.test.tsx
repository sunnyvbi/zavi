// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  earnings: null as unknown,
  onboard: vi.fn(),
  me: { setup: { complete: true }, creator: { country_code: "US" as string | null } },
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("./CreatorChrome", () => ({ useCreatorMe: () => ({ me: h.me, reload: () => {} }) }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return {
    ...actual,
    creatorApi: {
      earnings: async () => h.earnings,
      onboardingLink: (...a: unknown[]) => h.onboard(...a),
      taxFormsLink: async () => ({ url: "https://connect.stripe.test/tax" }),
    },
  };
});

import { CreatorEarningsScreen } from "./CreatorEarnings";

const earnings = (over: Record<string, unknown> = {}) => ({
  paid_cents: 0,
  held_cents: 0,
  on_the_way_cents: 0,
  lines: [],
  payout: { connected: false, details_submitted: false, payouts_enabled: false, country: "US", disabled_reason: null },
  payout_country_supported: true,
  ...over,
});

beforeEach(() => {
  h.me = { setup: { complete: true }, creator: { country_code: "US" } };
  h.onboard.mockReset();
  h.onboard.mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);

describe("setting up payouts before the first job", () => {
  it("a new creator with no jobs can open Stripe onboarding straight away", async () => {
    h.earnings = earnings();
    render(<CreatorEarningsScreen />);
    const button = await screen.findByRole("button", { name: "Set up payouts" });
    expect(screen.queryByText(/when you accept your first job/)).toBeNull();
    expect(screen.getByText("Set it up now so you are paid as soon as a business approves your work.")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(h.onboard).toHaveBeenCalledTimes(1));
  });

  it("a creator in a country Zavi cannot pay still gets no button", async () => {
    h.earnings = earnings({ payout_country_supported: false });
    render(<CreatorEarningsScreen />);
    await screen.findByText("Not available");
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
  });

  it("a creator already connected sees Manage in Stripe, not a second setup", async () => {
    h.earnings = earnings({ payout: { connected: true, details_submitted: true, payouts_enabled: true, country: "US", disabled_reason: null } });
    render(<CreatorEarningsScreen />);
    expect(await screen.findByRole("button", { name: "Manage in Stripe" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
  });
});

describe("payout setup waits for what Stripe needs, and says so", () => {
  it("with the profile unfinished, says to finish it first and offers no button that would fail", async () => {
    h.earnings = earnings();
    h.me = { setup: { complete: false }, creator: { country_code: "US" } };
    render(<CreatorEarningsScreen />);
    const note = await screen.findByTestId("payout-needs-profile");
    expect(note.textContent).toContain("Finish your profile first, then set up payouts here.");
    expect(screen.getByRole("link", { name: "Finish your profile" }).getAttribute("href")).toBe("/creator");
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
  });

  it("with no country yet, says to add it first and offers no button that would fail", async () => {
    h.earnings = earnings({ payout_country_supported: null });
    h.me = { setup: { complete: true }, creator: { country_code: null } };
    render(<CreatorEarningsScreen />);
    expect((await screen.findByTestId("payout-needs-country")).textContent).toContain("Add your country above first");
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
  });
});
