// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const compact = { value: true };
vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value,
}));

vi.mock("../agent/PerformanceMarketerDashboard", () => ({
  PerformanceMarketerDashboard: () => <div data-testid="paid" />,
}));
vi.mock("../agent/SeoGeoDashboard", () => ({
  SeoGeoDashboard: () => <div data-testid="seo" />,
}));
vi.mock("../agent/GeoDashboard", () => ({
  GeoDashboard: () => <div data-testid="geo" />,
}));
vi.mock("../agent/XAgentDashboard", () => ({
  XAgentDashboard: () => <div data-testid="x" />,
}));
vi.mock("../agent/AdsManagerDateRangePicker", () => ({
  AdsManagerDateRangePicker: () => <div data-testid="range" />,
  presetRange: () => ({ start: "2026-09-01", end: "2026-09-07" }),
  resolveWindow: () => ({ start: "2026-09-01", end: "2026-09-07" }),
}));

const NONE_LOCKED: Record<string, string | null> = {
  meta_ads: null,
  google_ads: null,
  seo: null,
  geo: null,
  reddit_organic: null,
  x_organic: null,
};
const channelLocks: { value: Record<string, string | null> | null } = { value: NONE_LOCKED };
vi.mock("./useChannelLocks", () => ({ useChannelLocks: () => channelLocks.value }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", treeAgents: [] }),
}));
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...actual, fetchLivePricingClient: async () => actual.PRICING_FALLBACK };
});

import { CompactHeaderSlotProvider } from "./compactHeaderSlot";
import { View360 } from "./View360";

const strip = () => screen.getByRole("tablist", { name: "Analytics section" });

const scroller = () => document.querySelector(".ws-scroll");

afterEach(() => {
  cleanup();
  compact.value = true;
  channelLocks.value = NONE_LOCKED;
  window.location.hash = "";
});

describe("analytics chrome on a phone", () => {
  it("keeps the tab strip out of the scrolling region, so it cannot scroll away", () => {
    render(<View360 />);
    const panel = scroller();

    expect(panel).not.toBeNull();
    expect(panel?.contains(strip())).toBe(false);
  });

  it("gives the strip a floor, so the numbers do not slide under it with no seam", () => {
    render(<View360 />);
    expect(strip().parentElement?.className).toContain("border-b");
  });

  it("contains a sideways flick on the strip's own axis only, so a vertical flick still reaches the page", () => {
    render(<View360 />);
    expect(strip().className).toContain("overscroll-x-contain");
    expect(strip().className).not.toContain("scroll-contain ");
    expect(strip().className).not.toContain("overscroll-contain");
  });

  it("lifts the one set of controls into the phone header and hides its own header row", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    try {
      const { container } = render(
        <CompactHeaderSlotProvider element={slot}>
          <View360 onExpand={() => {}} onCollapse={() => {}} />
        </CompactHeaderSlotProvider>,
      );
      const refresh = screen.getByRole("button", { name: "Refresh" });
      expect(slot.contains(refresh)).toBe(true);
      expect(slot.contains(screen.getByRole("button", { name: "Expand analytics" }))).toBe(true);
      expect(slot.contains(screen.getByRole("button", { name: "Hide analytics" }))).toBe(true);
      expect(slot.contains(screen.getByTestId("range"))).toBe(true);
      for (const name of ["Refresh", "Expand analytics", "Hide analytics"]) {
        expect(screen.getByRole("button", { name }).className).toContain("compact:h-10");
        expect(screen.getByRole("button", { name }).className).toContain("compact:w-10");
      }
      const header = container.querySelector("header");
      expect(header?.classList.contains("hidden")).toBe(true);
      expect(header?.contains(refresh)).toBe(false);
    } finally {
      slot.remove();
    }
  });

  it("keeps the inline controls at their desktop size when nothing lifts them", () => {
    render(<View360 onExpand={() => {}} />);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh.className).not.toContain("compact:h-10");
    expect(document.querySelector("header")?.classList.contains("hidden")).toBe(false);
  });

  it("scrolls the chosen tab back into view when the strip is wider than the screen", () => {
    const seen: Array<HTMLElement> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      seen.push(this);
    };

    try {
      render(<View360 />);
      seen.length = 0;

      const target = screen.getByRole("tab", { name: "SEO" });
      fireEvent.click(target);

      expect(seen).toContain(target);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("leaves the desktop strip where it is, because its tabs already fit", () => {
    compact.value = false;
    const seen: Array<HTMLElement> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      seen.push(this);
    };

    try {
      render(<View360 />);
      seen.length = 0;

      const target = screen
        .getAllByRole("tab")
        .find((t) => t.getAttribute("aria-selected") !== "true");

      expect(target).toBeTruthy();
      fireEvent.click(target as HTMLElement);
      expect(target?.getAttribute("aria-selected")).toBe("true");
      expect(seen).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("drops the duplicate 'Analytics' title a phone frame already shows, and keeps the controls", () => {
    render(<View360 />);
    const title = screen.getByRole("heading", { name: "Analytics" });

    expect(title.parentElement?.className).toContain("compact:hidden");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByTestId("range")).toBeTruthy();
  });
});

describe("per-channel plan lock", () => {
  const starterTenant = () => {
    channelLocks.value = { ...NONE_LOCKED, meta_ads: "pro", google_ads: "pro" };
  };

  it("opens on the first tab the plan includes, with its dashboard", () => {
    compact.value = false;
    starterTenant();
    render(<View360 />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("SEO");
    expect(screen.queryByRole("button", { name: /is a .* feature/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("a locked channel's tab stays visible, names its plan, and mounts no dashboard", () => {
    compact.value = false;
    starterTenant();
    render(<View360 onCollapse={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Meta Ads, Pro plan" }));
    expect(screen.getByRole("button", { name: /Meta Ads analytics is a Pro feature/ })).toBeTruthy();
    expect(screen.queryByTestId("paid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide analytics" })).toBeTruthy();
  });

  it("with every channel locked, opens on the cheapest lock", () => {
    compact.value = false;
    channelLocks.value = {
      meta_ads: "pro",
      google_ads: "pro",
      seo: "starter",
      geo: "starter",
      reddit_organic: "starter",
      x_organic: "starter",
    };
    render(<View360 />);
    expect(screen.getByRole("tab", { selected: true }).getAttribute("aria-label")).toBe("SEO, Starter plan");
    expect(screen.getByRole("button", { name: /SEO analytics is a Starter feature/ })).toBeTruthy();
  });

  it("with nothing locked, opens on Meta Ads as before", () => {
    compact.value = false;
    render(<View360 />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Meta Ads");
    expect(screen.getByTestId("paid")).toBeTruthy();
  });

  it("mounts no dashboard and no data controls until the locks have loaded", () => {
    compact.value = false;
    channelLocks.value = null;
    render(<View360 />);
    expect(screen.queryByTestId("paid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: /is a .* feature/ })).toBeNull();
    expect(screen.getByTestId("analytics-skeleton")).toBeTruthy();
  });

  it("drops the skeleton once the locks answer", () => {
    compact.value = false;
    channelLocks.value = { meta_ads: null };
    render(<View360 />);
    expect(screen.queryByTestId("analytics-skeleton")).toBeNull();
  });

  it("a channel the lock map does not name stays shut", () => {
    compact.value = false;
    channelLocks.value = {};
    render(<View360 />);
    expect(screen.queryByTestId("paid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });
});
