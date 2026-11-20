// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RecentBuilds, siteRowAsk } from "./BuildModePane";
import type { BuildSessionMeta } from "@/lib/workspace/buildHistory";

afterEach(cleanup);

function row(id: string, request: string, hostname: string): BuildSessionMeta {
  return {
    id,
    title: request,
    request,
    state: "ready",
    run_status: "done",
    created_at: "2026-10-13T07:00:00Z",
    last_activity_at: "2026-10-13T07:30:00Z",
    refine_count: 0,
    is_current: false,
    site: { hostname, live_url: null, status: "ready", name: "Saffron Spoon" },
  } as unknown as BuildSessionMeta;
}

const CATERING =
  "I'm Priya Shah and I run Saffron Spoon, a small Indian catering business in Austin. Additional context: - Name: Use the business name given in the idea above.";
const TRUCK = "Now a site for our Saffron Spoon food truck that parks downtown on weekends";

function rows(): HTMLElement[] {
  return within(screen.getByRole("region", { name: "Your sites" })).getAllByRole("listitem");
}

describe("two sites with the same name in YOUR SITES", () => {
  it("each row says what it was asked for, on screen and in its accessible name", () => {
    render(
      <RecentBuilds
        label="Your sites"
        siteNames
        currentSessionId={null}
        onOpen={vi.fn()}
        sessions={[row("a", CATERING, "saffron-spoon-5d47b917-241153.zaviagent.com"), row("b", TRUCK, "saffron-spoon-5d47b917-a3e971.zaviagent.com")]}
      />,
    );
    const [first, second] = rows();
    const names = [first!, second!].map((li) => within(li).getAllByRole("button")[0]!.textContent);
    expect(names[0]).not.toBe(names[1]);
    expect(within(first!).getByTestId("site-row-ask").textContent).toMatch(/^I'm Priya Shah and I run Saffron Spoon, a small Indian catering/);
    expect(within(first!).getByTestId("site-row-ask").textContent).not.toContain("Additional context");
    expect(within(second!).getByTestId("site-row-ask").textContent).toContain("food truck");
  });

  it("a site whose name is unique keeps its single line", () => {
    const other = { ...row("c", "A yoga studio site", "still-water-c.zaviagent.com"), site: { hostname: "still-water-c.zaviagent.com", live_url: null, status: "ready", name: "Still Water Yoga" } } as unknown as BuildSessionMeta;
    render(<RecentBuilds label="Your sites" siteNames currentSessionId={null} onOpen={vi.fn()} sessions={[row("a", CATERING, "x.zaviagent.com"), other]} />);
    expect(screen.queryAllByTestId("site-row-ask")).toHaveLength(0);
  });

  it("the ask line is clipped and never repeats the title", () => {
    expect(siteRowAsk("Saffron Spoon", "Saffron Spoon")).toBeNull();
    expect(siteRowAsk("x".repeat(200), "Saffron Spoon")!.length).toBeLessThanOrEqual(71);
  });
});
