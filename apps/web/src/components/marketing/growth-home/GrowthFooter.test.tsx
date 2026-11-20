// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({ track: vi.fn() }));

import { GrowthFooter, footerGroups } from "./GrowthFooter";
import { COMPARISONS, pathForComparison } from "@/lib/marketing/comparisons";
import { CHANNEL_PAGES } from "./channels/channelPages";

const START = "/start";

afterEach(cleanup);

function hrefOf(label: string): string {
  return screen.getByRole("link", { name: label }).getAttribute("href") ?? "";
}

describe("the growth footer", () => {
  it("sends a label that names a page to that page, not to the signup funnel", () => {
    render(<GrowthFooter startHref={START} />);
    expect(hrefOf("Channels")).toBe("/channels");
    expect(hrefOf("SEO agent")).toBe("/channels/seo");
    expect(CHANNEL_PAGES.some((c) => c.id === "seo")).toBe(true);
  });

  it("links For creators to the public creator landing", () => {
    render(<GrowthFooter startHref={START} />);
    expect(hrefOf("For creators")).toBe("/creators");
  });

  it("links Affiliates to the public affiliate program page", () => {
    render(<GrowthFooter startHref={START} />);
    expect(hrefOf("Affiliates")).toBe("/affiliates");
    const company = footerGroups(START).find((g) => g.heading === "Company")!;
    expect(company.links.map((l) => l.href)).toContain("/affiliates");
  });

  it("links Leaderboard to the public Growth Leaderboard", () => {
    render(<GrowthFooter startHref={START} />);
    expect(hrefOf("Leaderboard")).toBe("/growth");
  });

  it("keeps /start for exactly the labels with nothing built behind them", () => {
    render(<GrowthFooter startHref={START} />);
    const toStart = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === START)
      .map((a) => a.textContent)
      .sort();
    expect(toStart).toEqual(["Get started", "Integration", "Zavi for Slack", "Zavi for Teams"]);
  });
});

describe("the footer is grouped, not one flat list", () => {
  it("renders one headed list per group, in order", () => {
    const { container } = render(<GrowthFooter startHref={START} />);
    const sections = [...container.querySelectorAll('nav[aria-label="Footer"] > section')];
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual(["Product", "Compare", "Company", "Legal"]);
    for (const s of sections) expect(s.querySelectorAll("ul").length).toBe(1);
    expect(container.querySelectorAll('nav[aria-label="Footer"] > ul')).toHaveLength(0);
  });

  it("puts every link in exactly one group", () => {
    const labels = footerGroups(START).flatMap((g) => g.links.map((l) => l.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("builds the Compare column from the comparison pages, and nothing else goes there", () => {
    const compare = footerGroups(START).find((g) => g.heading === "Compare")!;
    expect(compare.links.map((l) => l.href)).toEqual(COMPARISONS.map((c) => pathForComparison(c.slug)));
    for (const g of footerGroups(START).filter((x) => x.heading !== "Compare")) {
      for (const l of g.links) expect(l.href.startsWith("/compare/"), l.label).toBe(false);
    }
  });

  it("keeps the legal links together in the Legal column", () => {
    const legal = footerGroups(START).find((g) => g.heading === "Legal")!;
    expect(legal.links.map((l) => l.href)).toEqual(["/privacy", "/terms", "/cookie-policy", "/legal/subprocessors"]);
  });
});
