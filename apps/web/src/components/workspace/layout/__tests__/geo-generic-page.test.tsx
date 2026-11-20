// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { GeoChannelPayload } from "../../geo/types";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../geo/GeoChannelPanel", () => ({
  GeoChannelPanel: () => <div>LEGACY GEO PANEL</div>,
}));

const geo = (CHANNELS as readonly Channel[]).find((c) => c.slug === "geo")!;

function payload(over: Partial<GeoChannelPayload> = {}): GeoChannelPayload {
  return {
    readiness: {
      status: "ok",
      site: "https://www.example.com",
      fetched_at: "2026-09-20T19:03:41.069+00:00",
      pages_analyzed: 16,
      score: {
        total: 54,
        bands: [
          { key: "citability", label: "Passage citability", weight: 25, score: 37, note: "Is there a self-contained answer near the top?" },
          { key: "structure", label: "Structural readability", weight: 20, score: 70, note: "One H1, no skipped levels." },
        ],
      },
      completeness: { below_floor: false, warning: null },
      disclosure: "Our own heuristic, computed only from the pages we fetched this run.",
      crawlers: [
        { name: "GPTBot", recommended: false, state: "partial" },
        { name: "OAI-SearchBot", recommended: true, state: "allowed" },
      ],
      llms_txt: true,
      findings: [
        { code: "geo_not_server_rendered", severity: "blocker", summary: "1 of 16 pages returned almost no readable text without JavaScript.", urls: ["https://www.example.com/search"] },
      ],
      not_checked: ["Whether you are actually cited in AI answers."],
      grade: "medium",
    },
    visibility: {
      state: "no_prompts",
      country: "US",
      window_days: 30,
      metrics: null,
      deltas: {
        mention_rate: { unavailable: "no earlier sweep" },
        citation_rate: { unavailable: "no earlier sweep" },
        share_of_voice: { unavailable: "no earlier sweep" },
      },
      running: null,
      history: [],
      config: {
        enabled: true,
        configured: true,
        brand: "Example",
        prompts_active: 1,
        suggestions_pending: 1,
        engines: [{ id: "chatgpt", label: "ChatGPT" }],
        countries: [{ country: "US", label: "United States", tracked: true }],
      },
    },
    crawler_hits: {
      disclosure: "Counted from the logs you send us.",
      state: "not_connected",
      window_days: 30,
      ingest: { connected: false, created_at: null, last_received_at: null },
      totals: { hits: 0, blocked_hits: 0 },
      bots: [
        { bot: "OAI-SearchBot", owner: "OpenAI", class: "search", recommended: true, hits: 0, blocked_hits: 0, robots: { state: "allowed" }, callout: null },
      ],
      daily: [],
    },
    prompts: {
      active: [{ id: "p1", prompt_text: "best car rental app", rationale: null, status: "active" }],
      suggested: [{ id: "p2", prompt_text: "cheapest way to rent a car", rationale: "Buyers ask this.", status: "suggested" }],
    },
    ...over,
  } as GeoChannelPayload;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(d: GeoChannelPayload | null = payload()) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/channels/geo/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/api/channels/geo/metrics")) return ok({ metrics: [] });
    if (u.includes("/api/channels/geo/history")) return ok(NO_HISTORY);
    if (u.includes("/api/agents/geo/dashboard")) {
      return d ? ok(d) : { ok: false, status: 500, json: async () => ({}) };
    }
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: geo,
  mode: "produce",
  connected: false,
  connectors: [],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(over: Partial<ChannelDetail> = {}, actionCount = 2) {
  const r = render(
    <ChannelDrawer
      detail={detail(over)}
      actionCount={actionCount}
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
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
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

describe("geo renders through the generic channel page", () => {
  it("draws the sampled answers and none of the old readiness tiles or tables", async () => {
    route();
    await open();
    expect(screen.getByTestId("geo-visibility")).toBeTruthy();
    expect(screen.queryByTestId("summary-row")).toBeNull();
    expect(screen.queryAllByTestId("extra-table")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Readiness/i })).toBeNull();
  });

  it("does not mount the panel it replaced", async () => {
    route();
    await open();
    expect(screen.queryByText("LEGACY GEO PANEL")).toBeNull();
  });

  it("the drawer no longer imports it, and reads no channel slug at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelDrawer.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/geo\/GeoChannelPanel"/);
    expect(src).not.toMatch(/channel\.slug\s*[!=]==\s*"/);
  });

  it("prints the action count once, not twice", async () => {
    route();
    const view = await open({}, 2);
    expect(view.container.textContent).not.toContain("2 actions waiting");
  });

  it("takes its width from the row, not from a branch", async () => {
    route();
    const view = await open();
    const { PLATFORMS } = await import("../../actions/platforms");
    expect(PLATFORMS.geo.maxWidth).toBe("max-w-[1180px]");
    expect(view.container.querySelector("[role='dialog']")).toBeTruthy();
  });

  it("draws no numbers and no strategy prompt when the read fails, with the action list intact", async () => {
    route(null);
    await open();
    expect(screen.queryByTestId("channel-value-empty")).toBeNull();
    expect(screen.queryByTestId("geo-visibility")).toBeNull();
    expect(screen.queryAllByTestId("extra-table")).toHaveLength(0);
    expect(screen.getByTestId("action-section")).toBeTruthy();
  });
});
