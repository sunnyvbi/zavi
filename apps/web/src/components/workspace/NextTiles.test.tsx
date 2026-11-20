// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_NEXT_TILES, type NextTile } from "@zavi/shared";

const compact = { value: false };
vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value,
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const track = vi.fn();
vi.mock("@/lib/analytics/mixpanel", () => ({ track: (...args: unknown[]) => track(...args) }));

const openStatic = vi.fn();
vi.mock("./layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layout/shared")>()),
  useOpenStatic: () => openStatic,
}));

let initialNextTiles: { tiles: NextTile[]; first_run_done: boolean } | null = null;
vi.mock("./WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ tenantName: "Apna Tutor", initialNextTiles }),
}));

import { NextTiles } from "./NextTiles";

const TILES: NextTile[] = [
  { kind: "plan", state: "none", key: "plan", label: "See your growth plan", detail: "Zavi writes it from your site" },
  { kind: "channel", state: "notrun", key: "seo", label: "Run SEO", detail: "Next in your plan" },
  {
    kind: "ask",
    state: "new",
    key: "What's my 30 day marketing strategy?",
    label: "Plan my next month",
    detail: "Answer in about a minute",
  },
];

const ok = (tiles: NextTile[]) =>
  Promise.resolve(new Response(JSON.stringify({ tiles }), { status: 200 }));

beforeEach(() => {
  compact.value = false;
  apiFetch.mockReset();
  track.mockReset();
  openStatic.mockReset();
  initialNextTiles = null;
});
afterEach(cleanup);

describe("NextTiles", () => {
  it("reserves the carousel shape without showing incorrect default copy", () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    render(<NextTiles onPrompt={() => {}} />);

    expect(screen.getByTestId("next-tiles").getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByTestId("next-tile-skeleton")).toHaveLength(3);
    expect(screen.queryByText(DEFAULT_NEXT_TILES[0].label)).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders server-provided personalized tiles on the first paint", () => {
    initialNextTiles = { tiles: TILES, first_run_done: true };
    apiFetch.mockReturnValue(new Promise(() => {}));
    const onFirstRunDone = vi.fn();

    render(
      <NextTiles
        onPrompt={() => {}}
        onFirstRunDone={onFirstRunDone}
      />,
    );

    expect(screen.getByText("See your growth plan")).toBeTruthy();
    expect(screen.queryAllByTestId("next-tile-skeleton")).toHaveLength(0);
    expect(onFirstRunDone).toHaveBeenCalledWith(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders the three tiles from the endpoint with no heading or subtext", async () => {
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    await screen.findByText("See your growth plan");
    expect(screen.queryByText(/Next for/i)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText("Zavi writes it from your site")).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/next-tiles");
  });

  it("falls back to the default tiles when the fetch fails", async () => {
    apiFetch.mockReturnValue(Promise.reject(new Error("offline")));
    render(<NextTiles onPrompt={() => {}} />);
    await screen.findByText(DEFAULT_NEXT_TILES[0].label);
    expect(screen.getAllByRole("button")).toHaveLength(DEFAULT_NEXT_TILES.length);
  });

  it("an ask tile sends the prompt through onPrompt and does not mark on its own", async () => {
    apiFetch.mockReturnValue(ok(TILES));
    const onPrompt = vi.fn();
    render(<NextTiles onPrompt={onPrompt} />);
    fireEvent.click(await screen.findByText("Plan my next month"));
    expect(onPrompt).toHaveBeenCalledWith("What's my 30 day marketing strategy?");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("/mark"))).toBe(false);
    expect(track).toHaveBeenCalledWith("home_next_tile_clicked", { kind: "ask", state: "new", position: 3 });
  });

  it("a channel tile opens that channel", async () => {
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    fireEvent.click(await screen.findByText("Run SEO"));
    expect(openStatic).toHaveBeenCalledWith("channels", { channel: "seo" });
  });

  it("the plan tile opens Growth Strategy", async () => {
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    fireEvent.click(await screen.findByText("See your growth plan"));
    expect(openStatic).toHaveBeenCalledWith("autopilot");
  });

  it("on a phone the tiles are one swipe row of one-line tiles", async () => {
    compact.value = true;
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    await screen.findByText("Run SEO");
    const row = screen.getByTestId("next-tiles-row");
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).not.toContain("grid-cols-3");
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-[44px]");
      expect(button.className).toContain("shrink-0");
    }
    expect(screen.queryByText("Next in your plan")).toBeNull();
    const labels = screen.getAllByTestId("next-tile-label");
    expect(labels.map((l) => l.textContent)).toEqual(TILES.map((t) => t.label));
    for (const label of labels) {
      expect(label.className).toContain("truncate");
      expect(label.outerHTML).not.toContain("container-type");
      expect(label.parentElement?.innerHTML ?? "").not.toContain("container-type");
    }
  });

  it("B39: on a phone each tile has its own width and a plain label, so it never collapses to its icon", async () => {
    compact.value = true;
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    await screen.findByText("Run SEO");
    for (const tile of TILES) {
      const button = screen.getByRole("button", { name: tile.label });
      const classes = button.className.split(/\s+/);
      expect(classes.some((c) => /^w-(\[\d+(%|px)\]|\d+\/\d+|\d+)$/.test(c))).toBe(true);
      expect(classes).toContain("max-w-[260px]");
      const label = screen.getByText(tile.label);
      expect(button.contains(label)).toBe(true);
      expect(label.className).toContain("truncate");
      expect(button.querySelector('[class*="container-type"]')).toBeNull();
    }
  });

  it("on a desktop the tiles keep the hover-scroll title", async () => {
    apiFetch.mockReturnValue(ok(TILES));
    render(<NextTiles onPrompt={() => {}} />);
    await screen.findByText("Run SEO");
    const button = screen.getByRole("button", { name: "Run SEO" });
    expect(button.querySelector('[class*="container-type"]')).not.toBeNull();
  });
});
