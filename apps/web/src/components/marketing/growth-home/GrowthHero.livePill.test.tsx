import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./fonts", () => ({ jakartaHeavy: { className: "" }, caveat: { className: "" } }));

import { GrowthHero } from "./GrowthHero";

describe("GrowthHero Live pill", () => {
  it("no pill unless a run is featured", () => {
    render(<GrowthHero startHref="/start" />);
    expect(screen.queryByTestId("hero-live-pill")).toBeNull();
  });
  it("links to the featured run", () => {
    render(<GrowthHero startHref="/start" livePillSlug="upcar" />);
    const pill = screen.getByTestId("hero-live-pill");
    expect(pill.getAttribute("href")).toBe("/live/upcar");
    expect(pill.textContent).toContain("See Zavi run a real company's growth, in real time");
  });
});
