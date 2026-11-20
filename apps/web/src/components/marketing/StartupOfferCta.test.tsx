// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ api: vi.fn(), track: vi.fn(), push: vi.fn(), session: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/api", () => ({ apiFetch: h.api }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({
  rpc: async () => ({ data: null }),
  auth: { getSession: async () => ({ data: { session: h.session ? {} : null } }) },
}) }));

import { StartupOfferCta } from "./StartupOfferCta";

beforeEach(() => {
  vi.clearAllMocks();
  h.session = true;
  h.api.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: "https://stripe.example/session" }) });
});
afterEach(cleanup);

describe("startup-offer analytics", () => {
  it("reports a checkout only after Stripe returns a URL", async () => {
    render(<StartupOfferCta />);
    fireEvent.click(screen.getByRole("button", { name: "Get 100,000 credits for $1" }));
    await waitFor(() => expect(h.track).toHaveBeenCalledWith("checkout_started", { offer: "launch-2026" }));
  });

  it("does not count a signup redirect as a checkout", async () => {
    h.session = false;
    render(<StartupOfferCta />);
    fireEvent.click(screen.getByRole("button", { name: "Get 100,000 credits for $1" }));
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.api).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });
});
