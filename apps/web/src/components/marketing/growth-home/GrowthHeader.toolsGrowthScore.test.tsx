// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({
  track: vi.fn(),
  resetAnalyticsIdentity: vi.fn(),
}));

import { GrowthHeader } from "./GrowthHeader";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CTA = { href: "/start", label: "Get started", shortLabel: "Start" };

describe("header Tools menu: growth score", () => {
  it("pins a Free growth score first, with the leaderboard and all tools reachable", () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    const panel = screen.getByRole("region", { name: "Tools menu" });
    const links = Array.from(panel.querySelectorAll("a"));

    const first = links[0];
    expect(first.getAttribute("href")).toBe("/start");
    expect(first.textContent).toContain("Growth score");
    expect(first.textContent).toContain("Free");
    expect(first.textContent).toContain("See where your site ranks.");

    const byText = (t: string) => links.find((a) => a.textContent?.includes(t));
    expect(byText("Get your growth score")?.getAttribute("href")).toBe("/start");
    expect(byText("See this week's leaderboard")?.getAttribute("href")).toBe("/growth");
    expect(byText("See all tools")?.getAttribute("href")).toBe("/tools");
  });
});
