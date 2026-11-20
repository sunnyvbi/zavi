import { describe, it, expect } from "vitest";
import {
  connectionTags,
  growthView,
  istDate,
  presetRange,
  personMatchesCard,
  safeWebsite,
  tenantMatchesCard,
  validDateRange,
  type GrowthData,
  type GrowthTenant,
} from "./tenants-growth";
import { fixture, tenant } from "./tenants-growth-fixture";
describe("growth reporting", () => {
  it("uses IST boundaries and inclusive presets", () => {
    expect(istDate("2026-10-12T18:29:59Z")).toBe("2026-10-12");
    expect(istDate("2026-10-12T18:30:00Z")).toBe("2026-10-13");
    expect(presetRange("7", "2026-10-13")).toEqual({
      from: "2026-10-07",
      to: "2026-10-13",
    });
    expect(presetRange("month", "2026-10-13").from).toBe("2026-10-01");
  });
  it("counts a person once across workspaces and includes unfinished signups", () => {
    const v = growthView(fixture, "2026-10-01", "2026-10-13", false);
    expect(v.cards).toMatchObject({ active: 2, today: 2, range: 2, paid: 0 });
    expect(v.tenants).toHaveLength(2);
    expect(v.chart).toHaveLength(13);
    expect(v.chart[0]).toEqual({ day: "2026-10-01", signups: 0, active: 0 });
  });
  it("uses the same test filter for all metrics and the table", () => {
    const v = growthView(fixture, "2026-10-01", "2026-10-13", true);
    expect(v.cards).toMatchObject({ active: 3, today: 3, range: 3, paid: 1 });
    expect(v.tenants).toHaveLength(3);
    expect(v.chart[12]).toMatchObject({ signups: 3, active: 3 });
  });
  it("hides only test workspaces, never a workspace for its owner's label", () => {
    const data: GrowthData = {
      ...fixture,
      tenants: fixture.tenants.map((t) =>
        t.id === "t3" ? { ...t, is_test: false } : t,
      ),
    };
    const v = growthView(data, "2026-10-01", "2026-10-13", false);
    expect(v.tenants.map((t) => t.id)).toContain("t3");
    expect(v.people.map((u) => u.id)).toContain("u3");
    expect(v.hidden).toBe(0);
  });
  it("filters all matching memberships without dropping unfinished signups", () => {
    const v = growthView(fixture, "2026-10-01", "2026-10-13", false);
    expect(
      tenantMatchesCard(
        tenant,
        "active",
        fixture,
        "2026-10-01",
        "2026-10-13",
        v.active,
        v.people,
      ),
    ).toBe(true);
    expect(
      personMatchesCard(
        fixture.users[1],
        "today",
        fixture,
        "2026-10-01",
        "2026-10-13",
        v.active,
      ),
    ).toBe(true);
    expect(
      tenantMatchesCard(
        fixture.tenants[1],
        "paid",
        fixture,
        "2026-10-01",
        "2026-10-13",
        v.active,
        v.people,
      ),
    ).toBe(false);
  });
  it("separates social LinkedIn from LinkedIn Ads and deduplicates tools", () => {
    expect(connectionTags(tenant)).toEqual({
      integrations: ["LinkedIn Ads", "Slack", "Stripe"],
      socials: ["LinkedIn"],
    });
  });
  it("rejects unsafe links and reversed/future ranges", () => {
    expect(safeWebsite("javascript:alert(1)")).toBeNull();
    expect(safeWebsite("https://user:pass@example.com")).toBeNull();
    expect(safeWebsite("https://example.com")).toBe("https://example.com/");
    expect(validDateRange("2026-10-14", "2026-10-13", "2026-10-13")).toBe(
      false,
    );
  });
  it("compares with the preceding equally sized period", () => {
    const d = {
      ...fixture,
      users: [
        ...fixture.users,
        { ...fixture.users[1], id: "old", signup_at: "2026-09-20T00:00:00Z" },
      ],
    };
    expect(
      growthView(d, "2026-10-01", "2026-10-13", false).cards.rangePrevious,
    ).toBe(1);
  });
});

it("separates complimentary access from paid customers and their card filter", () => {
  const paidTenant = { ...tenant, id: "paid", is_comp: false };
  const data = { ...fixture, tenants: [...fixture.tenants, paidTenant] };
  const view = growthView(data, "2026-10-01", "2026-10-13", false);
  expect(view.cards.paid).toBe(1);
  expect(view.paid.pro).toBe(1);
  expect(view.comps).toBe(1);
  expect(
    tenantMatchesCard(
      tenant,
      "paid",
      data,
      "2026-10-01",
      "2026-10-13",
      view.active,
      view.people,
    ),
  ).toBe(false);
  expect(
    tenantMatchesCard(
      paidTenant,
      "paid",
      data,
      "2026-10-01",
      "2026-10-13",
      view.active,
      view.people,
    ),
  ).toBe(true);
});
