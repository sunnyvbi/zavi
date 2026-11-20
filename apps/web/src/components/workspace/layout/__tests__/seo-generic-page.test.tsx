// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { SeoChannelPayload } from "../../seo/types";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../seo/SeoChannelPanel", () => ({
  SeoChannelPanel: () => <div>LEGACY SEO INSTRUMENT PANEL</div>,
}));

const seo = (CHANNELS as readonly Channel[]).find((c) => c.slug === "seo")!;

function payload(): SeoChannelPayload {
  return {
    generic: false,
    connected: false,
    site_health: {
      status: "ok",
      site: "https://www.example.com",
      error_code: null,
      fetched_at: "2026-09-20T19:03:41.069+00:00",
      stale: false,
      notes: [],
      pages_analyzed: 2,
      findings: [
        { code: "h1_missing", summary: "Two pages have no H1 heading.", urls: ["https://www.example.com/", "https://www.example.com/a"] },
      ],
      pages: [
        { url: "https://www.example.com/", status: 200, title: "Home", title_length: 4, meta_description: null, canonical: null, h1_count: 0, schema_types: [], noindex: false, visible_words: 300 },
        { url: "https://www.example.com/a", status: 200, title: "A", title_length: 1, meta_description: null, canonical: null, h1_count: 1, schema_types: [], noindex: false, visible_words: 120 },
      ],
    },
    performance: {
      lab: {
        state: "ok",
        truncated: false,
        pages: [
          {
            strategy: "mobile",
            final_url: "https://www.example.com/",
            requested_url: "https://www.example.com/",
            fetch_time: "2026-09-18T02:26:09.263Z",
            lighthouse_version: "13.4.1",
            categories: [{ id: "performance", title: "Performance", score: 0.35 }],
            opportunities: [
              {
                id: "bootup-time",
                title: "Reduce JavaScript execution time",
                score: 0,
                metricSavings: [{ metric: "TBT", value: 1450, unit: "ms" }],
                savingsMs: null,
                savingsBytes: null,
                culprits: [{ kind: "script", label: "main.js", owner: "developer", detail: "819 ms of main-thread time.", bytes: null, wastedBytes: null }],
              },
            ],
          },
        ],
      },
      field: {
        state: "ok",
        scope: "url",
        key: "https://www.example.com/",
        metrics: { largest_contentful_paint: { p75: 3214 }, cumulative_layout_shift: { p75: 0.33 } },
      },
      agent_readiness: {
        passed: 1,
        applicable: 2,
        disclosure: "Computed from the pages we fetched.",
        checks: [
          { id: "llms_txt", label: "Has an /llms.txt", state: "pass", detail: "/llms.txt exists at the root." },
          { id: "answer_block", label: "A self-contained answer", state: "fail", detail: "No answer block near the top." },
        ],
      },
      warming: false,
    },
  } as SeoChannelPayload;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(d: SeoChannelPayload | null = payload()) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/channels/seo/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/api/channels/seo/metrics")) return ok({ metrics: [] });
    if (u.includes("/api/channels/seo/history")) return ok(NO_HISTORY);
    if (u.includes("/api/agents/seo/dashboard")) {
      return d ? ok(d) : { ok: false, status: 500, json: async () => ({}) };
    }
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: seo,
  mode: "produce",
  connected: false,
  connectors: ["google_search_console"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(over: Partial<ChannelDetail> = {}) {
  const r = render(
    <ChannelDrawer
      detail={detail(over)}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((r2) => setTimeout(r2, 0));
    }
  });
  return r;
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetAgentDashCache();
});
afterEach(cleanup);

async function analytics() {
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openSettings() {
  await act(async () => {
    screen.getByRole("tab", { name: /Settings/i }).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("seo renders through the generic channel page", () => {
  it("does not mount the instrument panel it replaced", async () => {
    route();
    await open();
    expect(screen.queryByText("LEGACY SEO INSTRUMENT PANEL")).toBeNull();
  });

  it("the panel no longer imports it, or reads the slug at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelPanel.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/seo\/SeoChannelPanel"/);
    expect(src).not.toMatch(/channel\.slug\s*===\s*"seo"/);
  });

  it("draws the verdict, then six topic numbers with no table open", async () => {
    route();
    await open();
    await analytics();
    const health = screen.getByTestId("health-summary");
    expect(screen.getByTestId("health-headline").textContent).toBe("2 of 2 pages need fixes");
    expect(within(health).getByTestId("health-count-warning").textContent).toContain("1");

    const row = screen.getByTestId("summary-row");
    const tiles = Array.from(row.querySelectorAll("[data-metric]"));
    expect(tiles.map((t) => t.textContent ?? "")).toEqual([
      expect.stringContaining("Issues"),
      expect.stringContaining("Speed (lab)"),
      expect.stringContaining("Real visitors"),
      expect.stringContaining("Google SEO check"),
      expect.stringContaining("AI readiness"),
      expect.stringContaining("Structured data"),
    ]);
    expect(tiles[1].textContent).toContain("/100");
    expect(tiles[4].textContent).toContain("Not read yet");
    expect(screen.queryByTestId("metrics-empty")).toBeNull();

    expect(screen.queryAllByTestId("extra-table")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Top issues");
    expect(tiles[0].tagName).toBe("DIV");
    expect(within(row).getAllByRole("button")).toHaveLength(5);
  });

  it("swaps the table when another number is picked, and each opens its OWN lane", async () => {
    route();
    await open();
    await analytics();
    const buttons = within(screen.getByTestId("summary-row")).getAllByRole("button");
    await act(async () => {
      buttons[0].click();
      await Promise.resolve();
    });
    let tables = screen.getAllByTestId("extra-table");
    expect(tables).toHaveLength(1);
    expect(tables[0].textContent).toContain("What the page test says to fix");
    await act(async () => {
      buttons[1].click();
      await Promise.resolve();
    });
    tables = screen.getAllByTestId("extra-table");
    expect(tables).toHaveLength(1);
    expect(tables[0].textContent).toContain("What real visitors got");
    expect(tables[0].textContent).toContain("3.2 s");
  });

  it("draws no account line for the site it read, and no Connect card either", async () => {
    route();
    await open();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    const row = screen.getByTestId("channel-header");
    expect(row.textContent).not.toContain("www.example.com");
    expect(row.textContent).not.toContain("pages read");
    expect(within(screen.getByTestId("health-summary")).getByText(/2 pages read/)).toBeTruthy();
    expect(screen.queryByText(/Connect Google Search Console/i)).toBeNull();
    expect(screen.queryByTestId("metrics-empty")).toBeNull();
  });

  it("keeps the connect ask, on Settings, and off Overview", async () => {
    route();
    await open();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    await openSettings();
    expect(screen.getByText("Not connected yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("draws the posting settings page with the site Zavi is connected to", async () => {
    route();
    await open({ connected: true });
    await openSettings();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Connection", "How it sounds"]));
    expect(headings).not.toContain("Before Zavi posts");
    expect(headings).not.toContain("Tell me when");
    expect(screen.getByText("Google Search Console")).toBeTruthy();
    expect(screen.getByText("Connected to example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(await screen.findByLabelText("Voice on SEO")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create post" })).toBeNull();
  });

  it("degrades to the empty-metrics sentence when the read fails", async () => {
    route(null);
    await open();
    expect(screen.getByTestId("channel-value-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("extra-table")).toHaveLength(0);
    expect(screen.getByTestId("action-section")).toBeTruthy();
  });
});
