// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

import { ChannelHeaderRow } from "../ChannelHeaderRow";
import { ChannelPanel } from "../ChannelPanel";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const channel = (slug: string) =>
  (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

const REDDIT_PAYLOAD = {
  connected: true,
  manual_publish: true,
  research_summary: null,
  suggestions: [],
  insights: {
    has_data: true,
    sweep: {
      enabled: true,
      last: {
        id: "s1",
        status: "complete",
        trigger: "manual",
        started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        finished_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        posts_scanned: 10,
        comments_scanned: 5,
        communities_scanned: 2,
        error_code: null,
      },
      budget: { used_usd_7d: 1, cap_usd_7d: 10, exhausted: false },
      stale: false,
    },
  },
};

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard")) return ok(REDDIT_PAYLOAD);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
});

const detailFor = (slug: string): ChannelDetail => ({
  channel: channel(slug),
  mode: "produce",
  connected: true,
  connectors: ["reddit"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});

async function mountChannel(slug: string) {
  const view = render(
    <ChannelPanel detail={detailFor(slug)} actionCount={0} onOpenConnectors={() => {}} />,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const header = () => screen.getByTestId("channel-header");

const SPACING: Record<string, number> = {
  "0": 0,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "7": 28,
  "8": 32,
  "10": 40,
  "11": 44,
  "12": 48,
};

function sizeOf(className: string, axis: "h" | "w", variant = ""): number {
  const prefix = variant ? `${variant}:` : "";
  let found: number | null = null;
  for (const token of className.split(/\s+/)) {
    if (variant ? !token.startsWith(prefix) : token.includes(":")) continue;
    const bare = token.slice(prefix.length);
    const m = /^([hw])-(.+)$/.exec(bare);
    if (!m || m[1] !== axis) continue;
    const px = SPACING[m[2]];
    if (px === undefined) throw new Error(`unmapped spacing token: ${token}`);
    found = px;
  }
  return found ?? 0;
}

function discSize(className: string, variant = ""): number {
  const h = sizeOf(className, "h", variant) || sizeOf(className, "h");
  const w = sizeOf(className, "w", variant) || sizeOf(className, "w");
  expect(h).toBe(w);
  return h;
}

function insetOf(className: string, variant = ""): number {
  let found = 0;
  for (const token of className.split(/\s+/)) {
    const parts = token.split(":");
    const bare = parts.pop() as string;
    const m = /^-inset-(.+)$/.exec(bare);
    if (!m) continue;
    if (!parts.includes("after") && !parts.includes("before")) continue;
    const scoped = parts.some((x) => x !== "after" && x !== "before");
    if (variant ? !parts.includes(variant) : scoped) continue;
    const px = SPACING[m[1]];
    if (px === undefined) throw new Error(`unmapped inset token: ${token}`);
    found = px;
  }
  return found;
}

function tapTarget(className: string, variant = ""): number {
  const pad = insetOf(className, variant) || insetOf(className);
  return discSize(className, variant) + pad * 2;
}

describe("the channel header row", () => {
  it("keeps the tabs and the controls on one line at every width", () => {
    render(
      <ChannelHeaderRow left={<button type="button">Overview</button>} underline spaced>
        <div />
      </ChannelHeaderRow>,
    );

    const row = header();
    expect(row.className).not.toMatch(/compact:flex-col/);
    expect(row.className).not.toMatch(/compact:items-stretch/);
    expect(row.className).toContain("flex-wrap");
  });

  it("centres the tabs and the toolbar on one row, with the toolbar pushed right", () => {
    render(
      <ChannelHeaderRow left={<button type="button">Overview</button>} underline spaced>
        <div />
      </ChannelHeaderRow>,
    );

    expect(header().className).toContain("items-center");
    const slot = header().children[1] as HTMLElement;
    expect(slot.className).toContain("ml-auto");
    expect(slot.className).toContain("justify-end");
    expect(slot.className).toContain("min-w-0");
  });
});

describe("a real channel page's controls", () => {
  it("scrolls the tabs horizontally on narrow screens without crushing or wrapping their labels", async () => {
    await mountChannel("seo");

    const tablist = screen.getByRole("tablist", { name: "SEO views" });
    expect(tablist.className).toContain("max-w-full");
    expect(tablist.className).toContain("overflow-x-auto");
    expect(tablist.className).toContain("overscroll-x-contain");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("shrink-0");
      expect(tab.className).toContain("whitespace-nowrap");
    }
  });

  it("shows Refresh but no range menu on seo's Analytics tab, whose numbers are not for a period", async () => {
    await mountChannel("seo");
    fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
    await screen.findByRole("button", { name: /^(Refresh|Reading)/ });
    expect(header().querySelector('[aria-haspopup="listbox"]')).toBeNull();
  });

  it.each(["google_ads"])(
    "shows the range menu and a labelled Refresh on %s's Analytics tab only",
    async (slug) => {
      await mountChannel(slug);

      expect(screen.queryByRole("button", { name: /^(Refresh|Reading)/ })).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));

      const refresh = await screen.findByRole("button", { name: /^(Refresh|Reading)/ });
      expect(refresh.textContent).toMatch(/Refresh|Reading/);
      expect(refresh.querySelector("svg")).toBeTruthy();
      expect(refresh.className).toContain("shrink-0");
      expect(refresh.closest('[data-testid="channel-header"]')).toBe(header());
      const range = header().querySelector('[aria-haspopup="listbox"]') as HTMLElement;
      expect(range).toBeTruthy();
      expect(range.parentElement?.parentElement).toBe(refresh.parentElement);
    },
  );

  it("drops Refresh on a channel whose scan disc already re-reads the page", async () => {
    await mountChannel("reddit_organic");

    await screen.findByTestId("channel-scan");
    expect(screen.queryByRole("button", { name: /Refresh|Reading/ })).toBeNull();
  });

  it("keeps the scan action a disc at every width, never a labelled button", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByRole("button", { name: "Scan now" });
    expect(scan.className).toMatch(/(^|\s)h-8(\s|$)/);
    expect(scan.className).toMatch(/(^|\s)w-8(\s|$)/);
    expect(scan.className).toContain("rounded-full");
    expect(scan.className).not.toMatch(/compact:(w-auto|rounded-lg|px-3)/);
    expect(scan.textContent).toBe("");
    const icon = scan.querySelector("svg") as SVGElement;
    expect(icon.getAttribute("class")).toMatch(/(^|\s)h-3\.5(\s|$)/);
    expect(icon.getAttribute("class")).not.toMatch(/compact:[hw]-/);
  });

  it("never lets the disc grow past the tab row it sits beside", async () => {
    const view = await mountChannel("reddit_organic");

    const scan = screen.getByRole("button", { name: "Scan now" });
    const tab = view.container.querySelector('[role="tab"]') as HTMLElement;
    expect(tab.className).toContain("min-h-8");

    expect(discSize(scan.className)).toBeLessThanOrEqual(32);
    expect(discSize(scan.className, "compact")).toBe(discSize(scan.className));
  });

  it("pads the disc's tap target to 44px rather than growing the circle", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByRole("button", { name: "Scan now" });
    expect(scan.className).toContain("relative");
    expect(tapTarget(scan.className)).toBeGreaterThanOrEqual(44);
    expect(tapTarget(scan.className, "compact")).toBeGreaterThanOrEqual(44);
  });

  it("puts the scan line in the tab row, not on a band of its own", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByTestId("channel-scan");
    expect(scan.className).toContain("justify-end");
    expect(scan.className).not.toMatch(/compact:justify-(start|center)/);
    expect(header().contains(scan)).toBe(true);
  });

  it("keeps 'Scanned …' beside the disc on a wide pane, and drops it on a phone", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByTestId("channel-scan");
    const disc = screen.getByRole("button", { name: "Scan now" });
    const status = Array.from(scan.querySelectorAll("span")).find((s) =>
      /^Scanned\s/.test(s.textContent ?? ""),
    ) as HTMLElement;

    expect(status).toBeTruthy();
    expect(status.parentElement).toBe(disc.parentElement);
    expect(status.compareDocumentPosition(disc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scan.className).toContain("compact:flex-nowrap");
    expect(scan.className).toContain("compact:min-w-0");
    expect(status.className).toContain("compact:hidden");
  });

  it("shows only the scan disc on a phone without an orphan freshness decoration", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByTestId("channel-scan");
    for (const dot of Array.from(scan.querySelectorAll("[aria-label^='Scanned in'], [aria-label^='No successful scan in']"))) {
      expect(dot.className).toContain("compact:hidden");
    }

    const shownInCompact = Array.from(scan.children).filter(
      (el) => !el.className.includes("compact:hidden"),
    );
    expect(shownInCompact.map((el) => el.tagName)).toEqual(["BUTTON"]);
  });

  it("lets a blocked sentence wrap instead of squeezing it into a column", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/dashboard"))
        return ok({
          ...REDDIT_PAYLOAD,
          insights: {
            ...REDDIT_PAYLOAD.insights,
            sweep: { ...REDDIT_PAYLOAD.insights.sweep, enabled: false },
          },
        });
      if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
      if (u.includes("/settings")) return ok({ fields: {} });
      return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
    });

    await mountChannel("reddit_organic");

    const scan = await screen.findByTestId("channel-scan");
    expect(scan.textContent).toMatch(/scanning is turned off/);
    expect(scan.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(scan.className).not.toContain("compact:flex-nowrap");
  });

  it("gives the status room on a phone instead of letting it wrap", async () => {
    await mountChannel("reddit_organic");

    const scan = screen.getByTestId("channel-scan");
    expect(scan.className).toContain("compact:text-[14px]");
    expect(scan.className).toContain("compact:gap-2");
  });
});
