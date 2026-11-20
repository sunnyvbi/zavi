// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ api: vi.fn(), track: vi.fn() }));
vi.mock("@/fonts", () => ({ jakarta: { variable: "font-jakarta" } }));
vi.mock("@/lib/api", () => ({ apiFetch: h.api, apiUrl: (path: string) => path }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track }));

import { PricingPlans } from "./PricingPlans";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe("pricing analytics distinguishes Stripe destinations", () => {
  it.each(["url", "redirect"])("reports the %s response correctly", async (key) => {
    h.api.mockImplementation(async (path: string) => ({
      ok: true, status: 200,
      json: async () => path === "/api/billing/checkout"
        ? { [key]: "https://stripe.example/session" }
        : { tier: "free" },
    }));
    render(<PricingPlans signedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Start Growth" }));
    await waitFor(() => expect(h.track).toHaveBeenCalledWith(
      key === "url" ? "checkout_started" : "billing_portal_opened", { tier: "growth", term: "6mo" },
    ));
    expect(h.track).not.toHaveBeenCalledWith(key === "url" ? "billing_portal_opened" : "checkout_started", expect.anything());
    expect(h.track).toHaveBeenCalledWith("pricing_plan_selected", expect.objectContaining({ tier: "growth", location: "pricing_page" }));
  });
});
