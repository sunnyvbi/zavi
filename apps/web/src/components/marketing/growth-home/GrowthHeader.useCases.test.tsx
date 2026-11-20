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
import { USE_CASES } from "@/lib/marketing/useCases";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CTA = { href: "/start", label: "Get started", shortLabel: "Start" };

describe("header Use cases menu", () => {
  it("opens a panel listing all 13 use cases plus See all", () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    const button = screen.getByRole("button", { name: /Use case/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const panel = screen.getByRole("region", { name: "Use case menu" });
    const hrefs = Array.from(panel.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    for (const u of USE_CASES) expect(hrefs).toContain(`/use-cases/${u.slug}`);
    expect(USE_CASES).toHaveLength(13);
    expect(hrefs).toContain("/use-cases");
    expect(hrefs).toContain("/live/upcar");
    expect(panel.textContent).toContain("See all use cases");
  });

  it("sits in the desktop nav between Tools and Leaderboard", () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("hidden");
    expect(nav.className).toContain("md:flex");
    const labels = Array.from(nav.children).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Channels", "Tools", "Use case", "Leaderboard"]);
  });

  it("keeps the compact menu wide and constrains every use-case column", () => {
    vi.spyOn(window, "scrollY", "get").mockReturnValue(20);
    render(<GrowthHeader cta={CTA} email={null} />);
    fireEvent.scroll(window);
    fireEvent.click(screen.getByRole("button", { name: /Use case/ }));

    const panel = screen.getByRole("region", { name: "Use case menu" });
    expect(panel.className).toContain("max-w-marketing-menu");
    expect(panel.querySelector(".lg\\:grid-cols-3")).not.toBeNull();
    for (const link of panel.querySelectorAll('a[href^="/use-cases/"]')) {
      expect(link.className).toContain("min-w-0");
      expect(link.parentElement?.className).toContain("min-w-0");
    }
  });
});

describe("header menu signup links keep the homepage campaign tags", () => {
  it("rewrites every bare /start entry to the tagged CTA and leaves page links alone", () => {
    const tagged = "/start?utm_source=creator&utm_campaign=launch2";
    render(<GrowthHeader cta={{ ...CTA, href: tagged }} email={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Channels/ }));
    const panel = screen.getByRole("region", { name: "Channels menu" });
    const hrefs = Array.from(panel.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    const starts = hrefs.filter((h) => h.split(/[?#]/)[0] === "/start");
    expect(starts.length).toBeGreaterThan(0);
    for (const h of starts) expect(h).toBe(tagged);
    expect(hrefs).toContain("/channels");
  });
});
