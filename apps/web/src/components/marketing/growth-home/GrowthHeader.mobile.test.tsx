// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/analytics/mixpanel", () => ({
  track: vi.fn(),
  resetAnalyticsIdentity: vi.fn(),
}));

import { GrowthHeader } from "./GrowthHeader";

const CTA = { href: "/start", label: "Continue onboarding", shortLabel: "Continue" };

afterEach(cleanup);

function classesOf(text: string) {
  const el = screen.getByText(text);
  return el.className.split(/\s+/);
}

describe("signed-in growth header at phone width", () => {
  it("shows only the short CTA label below sm and only the full one from sm up", () => {
    render(<GrowthHeader cta={CTA} email="mohitdudhat22@gmail.com" />);

    expect(classesOf("Continue")).toContain("sm:hidden");
    const full = classesOf("Continue onboarding");
    expect(full).toContain("hidden");
    expect(full).toContain("sm:inline");
  });

  it("keeps the account control an initial-only circle at every width", () => {
    render(<GrowthHeader cta={CTA} email="mohit2703+september@gmail.com" />);

    const summary = document.querySelector("summary");
    expect(summary).not.toBeNull();
    const summaryClasses = summary!.className.split(/\s+/);
    expect(summaryClasses).toContain("size-10");
    expect(summaryClasses.filter((c) => c.startsWith("sm:") || c.startsWith("md:") || c.startsWith("lg:"))).toEqual([]);

    expect(classesOf("M").filter((c) => c.endsWith("hidden"))).toEqual([]);
    const handle = classesOf("mohit2703+september");
    expect(handle).toContain("hidden");
    expect(handle.filter((c) => /^(sm|md|lg|xl):(inline|block|flex)/.test(c))).toEqual([]);
    const caret = summary!.querySelector("svg")!.getAttribute("class")!.split(/\s+/);
    expect(caret).toContain("hidden");
    expect(caret.filter((c) => /^(sm|md|lg|xl):(inline|block|flex)/.test(c))).toEqual([]);
  });

  it("keeps the full email inside the open menu", () => {
    render(<GrowthHeader cta={CTA} email="mohitdudhat22@gmail.com" />);
    expect(screen.getByText("mohitdudhat22@gmail.com")).toBeTruthy();
  });
});

describe("signed-out growth header at 320px", () => {
  it("moves Sign in into the menu panel below 375px only", () => {
    render(<GrowthHeader cta={{ href: "/start", label: "Get started" }} email={null} />);
    const barLink = screen.getByRole("link", { name: "Sign in" });
    expect(barLink.className.split(/\s+/)).toContain("phone:hidden");
    expect(screen.getByRole("link", { name: "Get started" }).className.split(/\s+/)).toContain("phone:px-3");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const panel = screen.getByRole("navigation", { name: "Menu" });
    const panelLink = within(panel).getByRole("link", { name: "Sign in" });
    expect(panelLink.getAttribute("href")).toBe("/login");
    expect(panelLink.closest("li")!.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "phone:block"]));
  });

  it("keeps no panel Sign in for a signed-in visitor", () => {
    render(<GrowthHeader cta={CTA} email="mohitdudhat22@gmail.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const panel = screen.getByRole("navigation", { name: "Menu" });
    expect(within(panel).queryByRole("link", { name: "Sign in" })).toBeNull();
  });
});
