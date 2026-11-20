// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: nav.replace }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({ default: (p: { alt: string }) => <span>{p.alt}</span> }));
const api = vi.hoisted(() => ({ payoutRefresh: vi.fn(), onboardingLink: vi.fn() }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: api };
});

import StripeReturnPage from "./page";

const payout = (over: Record<string, unknown>) => ({
  payout: { transfers_active: false, payouts_enabled: false, details_submitted: true, disabled_reason: null, ...over },
  released_payouts: 0,
});

beforeEach(() => {
  nav.replace.mockReset();
  api.payoutRefresh.mockReset();
  api.onboardingLink.mockReset();
});
afterEach(cleanup);

describe("Stripe return page", () => {
  it("goes straight to Earnings once transfers are active", async () => {
    api.payoutRefresh.mockResolvedValue(payout({ transfers_active: true }));
    render(<StripeReturnPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/creator/earnings"));
  });

  it("offers Continue with Stripe when Stripe still needs details, and mints a fresh link", async () => {
    api.payoutRefresh.mockResolvedValue(payout({ details_submitted: false, action_required: true }));
    api.onboardingLink.mockResolvedValue({ url: "https://connect.stripe.test/setup" });
    render(<StripeReturnPage />);
    expect(await screen.findByText("Finish setting up payouts")).toBeTruthy();
    expect(screen.queryByText(/Stripe is confirming/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Stripe" }));
    await waitFor(() => expect(api.onboardingLink).toHaveBeenCalledTimes(1));
  });

  it("says Stripe is confirming only when nothing is owed", async () => {
    api.payoutRefresh.mockResolvedValue(payout({ action_required: false }));
    render(<StripeReturnPage />);
    expect(await screen.findByText("Stripe is confirming your account")).toBeTruthy();
    expect(screen.queryByText("Finish setting up payouts")).toBeNull();
  });

  it("shows the error with a retry when the check fails", async () => {
    api.payoutRefresh.mockRejectedValueOnce(new Error("boom"));
    render(<StripeReturnPage />);
    expect(await screen.findByText("We could not check your payouts")).toBeTruthy();
    api.payoutRefresh.mockResolvedValueOnce(payout({ transfers_active: true }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/creator/earnings"));
  });
});
