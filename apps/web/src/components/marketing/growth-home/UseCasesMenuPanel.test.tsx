// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({
  track: vi.fn(),
  resetAnalyticsIdentity: vi.fn(),
}));

import { GrowthHeader } from "./GrowthHeader";
import { startHrefForWebsite } from "./UseCasesMenuPanel";
import { findUseCase } from "@/lib/marketing/useCases";
import { LIVE_STATS_STORAGE_KEY, resetLiveStatsForTests } from "@/lib/marketing/liveStats";

const CTA = { href: "/start", label: "Get started", shortLabel: "Start" };

const STORED = {
  as_of: "2026-09-22T12:00:00.000Z",
  metrics: {
    tokens_processed: { value: 4_859_636_642, rate_per_sec: 1030 },
    agent_steps: { value: 400, rate_per_sec: 0.0005 },
  },
};

beforeEach(() => {
  resetLiveStatsForTests();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openUseCases() {
  render(<GrowthHeader cta={CTA} email={null} />);
  fireEvent.click(screen.getByRole("button", { name: /Use case/ }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return screen.getByRole("region", { name: "Use case menu" });
}

const itemLink = (panel: HTMLElement, name: string) =>
  within(panel).getByText(name, { selector: "span.truncate" }).closest("a")!;

describe("Use cases menu panel", () => {
  it("keeps homepage tags on the header button and the use-case signup form", async () => {
    const tagged = "/start?utm_source=linkedin&utm_medium=social&utm_campaign=launch2";
    render(<GrowthHeader cta={{ ...CTA, href: tagged }} email={null} />);
    expect(screen.getByRole("link", { name: /Get started/ }).getAttribute("href")).toBe(tagged);
    fireEvent.click(screen.getByRole("button", { name: /Use case/ }));
    await act(async () => { await Promise.resolve(); });
    const panel = screen.getByRole("region", { name: "Use case menu" });
    fireEvent.mouseEnter(itemLink(panel, "Restaurants"));
    const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>('a[href^="/start"]'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(new URL(link.href).searchParams.get("utm_source")).toBe("linkedin");
    expect(new URL(startHrefForWebsite("example.com", tagged), "https://www.zaviagent.com").searchParams.get("utm_campaign")).toBe("launch2");
  });
  it("at rest leads with the live numbers; Upcar is only a small story link", async () => {
    const panel = await openUseCases();
    const rest = within(panel).getByTestId("use-cases-panel-rest");
    expect(rest.textContent).not.toContain("Upcar runs on Zavi.");
    expect(rest.textContent).toContain("Customer story:");
    const story = within(rest).getByRole("link", { name: /how Upcar runs on Zavi/ });
    expect(story.getAttribute("href")).toBe("/live/upcar");
  });

  it("the live numbers are fetched at page load, before the menu opens", async () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds the tiles with empty slots while the first reading is on its way", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<GrowthHeader cta={CTA} email={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Use case/ }));
    const panel = screen.getByRole("region", { name: "Use case menu" });
    const strip = within(panel).getByTestId("live-stats-strip");
    expect(within(strip).getAllByTestId("live-stats-slot")).toHaveLength(2);
    expect(strip.textContent).toContain("tokens processed");
    expect(strip.textContent).toContain("agent steps run");
  });

  it("shows a stored reading at once while the fetch is still in flight", async () => {
    window.localStorage.setItem(LIVE_STATS_STORAGE_KEY, JSON.stringify(STORED));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<GrowthHeader cta={CTA} email={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Use case/ }));
    const strip = within(screen.getByRole("region", { name: "Use case menu" })).getByTestId("live-stats-strip");
    expect(strip.textContent).toContain("4,859,636,642 tokens processed");
  });

  it("hides the live strip when the fetch fails and nothing is stored", async () => {
    const panel = await openUseCases();
    expect(within(panel).queryByTestId("live-stats-strip")).toBeNull();
    expect(panel.textContent).not.toContain("Live across Zavi");
  });

  it("shows the stored payload, frozen, when the fetch fails", async () => {
    window.localStorage.setItem(LIVE_STATS_STORAGE_KEY, JSON.stringify(STORED));
    const panel = await openUseCases();
    const strip = within(panel).getByTestId("live-stats-strip");
    expect(strip.textContent).toContain("Across Zavi");
    expect(strip.textContent).not.toContain("Live across Zavi");
    expect(strip.textContent).toContain("4,859,636,642 tokens processed");
    expect(strip.textContent).toContain("400 agent steps run");
  });

  it("hovering Restaurants swaps to its week with no Upcar mention; leaving returns to rest", async () => {
    const panel = await openUseCases();
    const r = findUseCase("restaurants")!;
    fireEvent.mouseEnter(itemLink(panel, "Restaurants"));
    const week = within(panel).getByTestId("use-cases-panel-week");
    expect(week.textContent).toContain("Your week with Zavi");
    expect(week.textContent).toContain("Example plan");
    expect(week.textContent).toContain("What Zavi could do for your restaurant this week");
    for (const d of r.week.days) expect(week.textContent).toContain(d);
    for (const d of ["MON", "TUE", "WED", "THU"]) expect(week.textContent).toContain(d);
    expect(week.textContent).not.toMatch(/Upcar/);
    expect(within(panel).queryByTestId("use-cases-panel-rest")).toBeNull();

    fireEvent.mouseLeave(panel);
    expect(within(panel).getByTestId("use-cases-panel-rest")).toBeTruthy();
  });

  it("keyboard focus on an item has the same effect as hover", async () => {
    const panel = await openUseCases();
    fireEvent.focus(itemLink(panel, "Law firms"));
    const week = within(panel).getByTestId("use-cases-panel-week");
    expect(week.textContent).toContain(findUseCase("law-firms")!.week.days[0]);
    expect(week.textContent).not.toMatch(/Upcar/);
  });

  it("Make it mine links to /start?website=example.com, and bare /start when empty", async () => {
    const panel = await openUseCases();
    fireEvent.mouseEnter(itemLink(panel, "SaaS"));
    const week = within(panel).getByTestId("use-cases-panel-week");
    expect(week.textContent).toContain("What Zavi could do for your SaaS this week");
    const mine = within(week).getByRole("link", { name: /Make it mine/ });
    expect(mine.getAttribute("href")).toBe("/start");
    const input = within(week).getByPlaceholderText("yoursite.com");
    fireEvent.change(input, { target: { value: "example.com" } });
    expect(mine.getAttribute("href")).toBe("/start?website=example.com");
    expect(startHrefForWebsite("  https://a.co/x?y=1 ")).toBe("/start?website=https%3A%2F%2Fa.co%2Fx%3Fy%3D1");
  });

  it("the other menus keep their plain aside", async () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Channels/ }));
    const panel = screen.getByRole("region", { name: "Channels menu" });
    expect(panel.textContent).toContain("One agent across all of them.");
    expect(within(panel).queryByTestId("use-cases-panel-rest")).toBeNull();
  });
});
