// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), checkout: vi.fn() }));
vi.mock("@/fonts", () => ({ jakarta: { variable: "font-jakarta" } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch, apiUrl: (p: string) => p }));

import { PricingPlans } from "../PricingPlans";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";

const START = "http://localhost/pricing";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkout.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.test/s" }) });
  mocks.apiFetch.mockImplementation(async (url: string, init?: unknown) =>
    url === "/api/billing/checkout"
      ? mocks.checkout(url, init)
      : { ok: true, status: 200, json: async () => ({ tier: "free" }) },
  );
  Object.defineProperty(window, "location", { configurable: true, value: { href: START } });
});
afterEach(cleanup);

const card = (slug: string) => document.querySelector(`[data-tier="${slug}"]`) as HTMLElement;
const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const checkoutBody = () => JSON.parse((mocks.checkout.mock.calls[0][1] as { body: string }).body);

describe("pricing page: billing term", () => {
  it("opens on 6 Months, the offer we lead with", () => {
    render(<PricingPlans />);
    expect(screen.getByRole("group", { name: "Billing period" })).toBeTruthy();
    expect(button(/6 Months/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/^Monthly$/).getAttribute("aria-pressed")).toBe("false");
    expect(button(/6 Months/).textContent).toContain("50% OFF");
    expect(card("growth").textContent).toContain("60/mo");
  });

  it("opens on Monthly when the backend says six months cannot be bought", () => {
    render(<PricingPlans sixMonthAvailable={false} />);
    expect(button(/^Monthly$/).getAttribute("aria-pressed")).toBe("true");
    expect(card("growth").textContent).toContain("120/mo");
    expect(document.querySelector("del")).toBeNull();
  });

  it("Monthly shows list prices with no struck-through price", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/^Monthly$/));
    expect(card("growth").textContent).toContain("120/mo");
    expect(document.querySelector("del")).toBeNull();
  });

  it("6 Months leads with the per-month price, the monthly one struck through, and the term's saving", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/6 Months/));
    const growth = card("growth");
    expect(growth.textContent).toContain("60/mo");
    expect(growth.querySelector("del")?.textContent).toContain("$120");
    expect(growth.textContent).toContain("Save $360");
    expect(growth.textContent).toContain("$360 billed every 6 months");
    expect(card("starter").textContent).toContain("10/mo");
    expect(card("starter").querySelector("del")?.textContent).toContain("$20");
    expect(card("starter").textContent).toContain("Save $60");
    expect(card("pro").querySelector("del")?.textContent).toContain("$240");
    expect(card("pro").textContent).toContain("Save $720");
  });

  it("every paid card still states its credits on the six-month term", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/6 Months/));
    expect(card("starter").textContent).toContain("8,000");
    expect(card("growth").textContent).toContain("48,000");
    expect(card("pro").textContent).toContain("96,000");
    for (const slug of ["starter", "growth", "pro"]) {
      expect(card(slug).textContent).toContain("+ 1,000 credits added daily*");
    }
  });

  it("does not print the credits twice on Monthly", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/^Monthly$/));
    expect((card("growth").textContent || "").match(/48,000/g)?.length).toBe(1);
  });

  it("Free keeps its monthly $0 on the six-month term", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/6 Months/));
    expect(card("free").querySelector("del")).toBeNull();
    expect(card("free").textContent).toContain("0/mo");
    expect(card("free").textContent).toContain("1,000 credits added daily*. No card.");
    expect(card("free").textContent).not.toContain("Save $");
  });

  it("the discount and both six-month figures render what the server sends", () => {
    const tiers = PRICING_FALLBACK.tiers.map((t) =>
      t.slug === "growth" ? { ...t, sixMonthPerMonthUsd: 70, sixMonthUsd: 420 } : t,
    );
    render(<PricingPlans tiers={tiers} sixMonthDiscountPct={40} />);
    expect(button(/6 Months/).textContent).toContain("40% OFF");
    fireEvent.click(button(/6 Months/));
    expect(card("growth").textContent).toContain("70/mo");
    expect(card("growth").textContent).toContain("Save $300");
  });

  it("signed in on 6 Months, Start Growth posts {tier, term} — never a price", async () => {
    render(<PricingPlans signedIn />);
    fireEvent.click(button(/6 Months/));
    fireEvent.click(button(/^Start Growth$/));
    await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.test/s"));
    expect(checkoutBody()).toEqual({ tier: "growth", term: "6mo" });
  });

  it("signed in on Monthly still posts the monthly term", async () => {
    render(<PricingPlans signedIn />);
    fireEvent.click(button(/^Monthly$/));
    fireEvent.click(button(/^Start Starter$/));
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalled());
    expect(checkoutBody()).toEqual({ tier: "starter", term: "monthly" });
  });

  it.each(["price_not_configured", "price_misconfigured"])(
    "a six-month %s 503 is said inline and the buyer stays on the page",
    async (code) => {
      mocks.checkout.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code } }) });
      render(<PricingPlans signedIn />);
      fireEvent.click(button(/6 Months/));
      fireEvent.click(button(/^Start Growth$/));
      expect(await screen.findByText(/Six-month billing isn.t open yet/)).toBeTruthy();
      expect(window.location.href).toBe(START);
    },
  );

  it.each(["billing_not_configured", "price_not_configured"])(
    "signed in, a monthly %s 503 is said on the page — no redirect to /start",
    async (code) => {
      mocks.checkout.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code } }) });
      render(<PricingPlans signedIn />);
      fireEvent.click(button(/^Monthly$/));
      fireEvent.click(button(/^Start Growth$/));
      expect((await screen.findByRole("alert")).textContent).toMatch(/Checkout isn.t open for this plan yet/);
      expect(window.location.href).toBe(START);
    },
  );

  it("switching the billing term clears a refusal left by the previous term", async () => {
    mocks.checkout.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "price_not_configured" } }),
    });
    render(<PricingPlans signedIn />);
    fireEvent.click(button(/6 Months/));
    fireEvent.click(button(/^Start Growth$/));
    expect(await screen.findByText(/Six-month billing isn.t open yet/)).toBeTruthy();

    fireEvent.click(button(/^Monthly$/));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("signed in with an expired session, a click signs in again and returns to /pricing", async () => {
    mocks.checkout.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    render(<PricingPlans signedIn />);
    fireEvent.click(button(/^Start Starter$/));
    await waitFor(() => expect(window.location.href).toBe("/login?next=%2Fpricing"));
  });

  it("signed out, a paid card goes to /start without calling checkout, on either term", () => {
    render(<PricingPlans />);
    fireEvent.click(button(/6 Months/));
    fireEvent.click(button(/^Start Pro$/));
    expect(window.location.href).toBe("/start?plan=pro&term=6mo");
    fireEvent.click(button(/^Monthly$/));
    fireEvent.click(button(/^Start Pro$/));
    expect(window.location.href).toBe("/start?plan=pro&term=monthly");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});

describe("the six-month credits line against a backend that already says it", () => {
  const LIVE_TIERS = PRICING_FALLBACK.tiers.map((t) =>
    t.slug === "growth"
      ? { ...t, includes: ["Everything in Starter", "48,000 credits a month plus 1,000 a day"] }
      : t,
  );

  it.each(["6 Months", "Monthly"])("states the pool exactly once on %s, whatever includes says", (term) => {
    render(<PricingPlans tiers={LIVE_TIERS} />);
    fireEvent.click(button(term === "Monthly" ? /^Monthly$/ : /6 Months/));
    const growth = card("growth");
    expect(growth.textContent?.match(/48,000/g) ?? []).toHaveLength(1);
    expect(growth.textContent).toContain("+ 1,000 credits added daily*");
  });
});
