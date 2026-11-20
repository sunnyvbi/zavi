// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
vi.mock("./useCards", () => ({
  callJson: vi.fn(async (path: string, init?: { body?: Record<string, unknown> }) => {
    calls.push({ path, body: init?.body });
    if (path === "/api/humans/orders/quote") {
      return {
        ok: true,
        data: {
          quote: {
            source: "booking",
            creator: { human_member_id: "m1", display_name: "Maya Films", slug: null, city: null, country_code: "US", payout_supported: true },
            job: { title: "UGC Video- 30 Sec", kind: "ugc_video", delivery_days: 2, package_id: "p1", offer_id: null, application_id: null, brief_id: "b1" },
            brief_prefill: null,
            money: { currency: "usd", price_cents: 100, business_fee_cents: 10, business_total_cents: 110, business_fee_label: "10%" },
            due_at: null,
            due_deadline: null,
            accept_window: { hours: 72, consequence_text: "" },
            needs_large_amount_confirm: false,
            large_amount_confirm_cents: 0,
            blocked: null,
          },
        },
      };
    }
    if (path === "/api/humans/orders") return { ok: false, message: "stop here" };
    return { ok: true, data: {} };
  }),
  useCreatorCards: () => ({}),
}));

import { HireDrawer } from "./HireDrawer";

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

describe("booking a package from a brief's applicant keeps the brief", () => {
  it("quotes and holds with the brief id, so the hire can close the brief", async () => {
    window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=hire&package=p1&brief=b1");
    render(<HireDrawer />);
    const hold = await screen.findByRole("button", { name: /^Hold \$1\.10/ });
    expect(calls.find((c) => c.path === "/api/humans/orders/quote")?.body).toMatchObject({ target: { package_id: "p1" }, brief_id: "b1" });
    fireEvent.click(hold);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/orders")).toBe(true));
    expect(calls.find((c) => c.path === "/api/humans/orders")?.body).toMatchObject({ target: { package_id: "p1" }, brief_id: "b1" });
  });

  it("a package booked with no brief sends none", async () => {
    window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=hire&package=p1");
    render(<HireDrawer />);
    fireEvent.click(await screen.findByRole("button", { name: /^Hold \$1\.10/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/orders")).toBe(true));
    expect(calls.find((c) => c.path === "/api/humans/orders/quote")?.body).not.toHaveProperty("brief_id");
    expect(calls.find((c) => c.path === "/api/humans/orders")?.body?.brief_id).toBeUndefined();
  });
});
