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
import { NAV_MENUS, NAV_LINKS, type NavMenuKey } from "./growthNavData";

const CTA = { href: "/start", label: "Get started" };

afterEach(cleanup);

function open() {
  render(<GrowthHeader cta={CTA} email={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
}

describe("the growth header below md", () => {
  it("keeps the nav reachable — the desktop one is display-gated, so a control has to replace it", () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    const desktop = screen.getByRole("navigation", { name: "Primary" });
    expect(desktop.className).toContain("hidden");
    expect(desktop.className).toContain("md:flex");

    const trigger = screen.getByRole("button", { name: "Open navigation" });
    expect(trigger.className).toContain("md:hidden");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reaches every destination the desktop menus reach", () => {
    open();
    const menu = screen.getByRole("navigation", { name: "Menu" });
    const hrefs = new Set(
      [...menu.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    );

    for (const key of Object.keys(NAV_MENUS) as NavMenuKey[]) {
      if (key === "integration") continue;
      for (const item of NAV_MENUS[key].items) {
        expect(hrefs.has(item.href)).toBe(true);
      }
    }
    for (const link of NAV_LINKS) {
      expect(hrefs.has(link.href)).toBe(true);
    }
  });

  it("closes on Escape and on following a link, so the panel cannot trap the page", () => {
    open();
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Menu" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const menu = screen.getByRole("navigation", { name: "Menu" });
    fireEvent.click(within(menu).getByRole("link", { name: "Pricing" }));
    expect(screen.queryByRole("navigation", { name: "Menu" })).toBeNull();
  });

  it("never shows both the desktop mega-menu and the phone panel at once", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /^Channels/ }));
    expect(screen.queryByRole("navigation", { name: "Menu" })).toBeNull();
  });
});

describe("For creators in the growth header", () => {
  it("sits on the RIGHT, next to Sign in, not in the left nav the centred logo can overlap", () => {
    render(<GrowthHeader cta={CTA} email={null} />);
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).queryByRole("link", { name: "For Creators" })).toBeNull();

    const link = screen.getByRole("link", { name: "For Creators" });
    expect(link.getAttribute("href")).toBe("/creators");
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(link.parentElement).toBe(signIn.parentElement);
    expect(link.nextElementSibling).toBe(signIn);
  });

  it("is reachable from the phone menu too", () => {
    open();
    const menu = screen.getByRole("navigation", { name: "Menu" });
    expect(within(menu).getByRole("link", { name: "For Creators" }).getAttribute("href")).toBe("/creators");
  });
});
