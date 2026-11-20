// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { makeAction } from "../../actions/__tests__/fixtures";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../actions/MetaAdsActions", () => ({
  MetaAdsActions: () => <div>LEGACY META LANE</div>,
}));

const meta = (CHANNELS as readonly Channel[]).find((c) => c.slug === "meta_ads")!;
const SLUG = "meta_ads";

const RANKED: ChannelActionView[] = [
  makeAction("check", { channel_slug: SLUG, title: "RANKED A — first out of the ranker" }),
  makeAction("check", { channel_slug: SLUG, title: "RANKED B — second" }),
  makeAction("check", { channel_slug: SLUG, title: "RANKED C — third" }),
];

const CHILDREN = (
  <>
    <li>UNRANKED Z — newest by proposed_at</li>
  </>
);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(list: {
  actions?: ChannelActionView[];
  more?: number;
  store?: string;
  fail?: boolean;
}) {
  apiFetch.mockImplementation(async (path: string) => {
    const u = String(path);
    if (u.includes(`/api/channels/${SLUG}/actions`)) {
      if (list.fail) return { ok: false, status: 500, json: async () => ({}) };
      return ok({
        actions: list.actions ?? [],
        more: list.more ?? 0,
        store: list.store ?? "channel_actions",
      });
    }
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${SLUG}/history`)) return ok(NO_HISTORY);
    return ok({ metrics: [], briefs: [], artifacts: [], snapshots: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: meta,
  mode: "produce",
  connected: true,
  connectors: ["meta_ads"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(over: Partial<ChannelDetail> = {}, actionCount = 1) {
  const r = render(
    <ChannelDrawer
      detail={detail(over)}
      actionCount={actionCount}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    >
      {CHILDREN}
    </ChannelDrawer>,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((r2) => setTimeout(r2, 0));
    }
  });
  return r;
}

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("meta_ads renders through the generic channel page", () => {
  it("does not mount the lane it replaced", async () => {
    route({ actions: RANKED });
    await open();
    expect(screen.queryByText("LEGACY META LANE")).toBeNull();
  });

  it("the panel no longer imports the lane, or reads the slug at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelPanel.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/actions\/MetaAdsActions"/);
    expect(src).not.toMatch(/channel\.slug\s*===\s*"meta_ads"/);
  });

  it("paints the ranker's rows, in the ranker's order, and not the drawer's children", async () => {
    route({ actions: RANKED });
    await open();
    const section = screen.getByTestId("action-section");
    const titles = Array.from(section.querySelectorAll("article h4")).map((h) => h.textContent);
    expect(titles).toEqual([
      "RANKED A — first out of the ranker",
      "RANKED B — second",
      "RANKED C — third",
    ]);
    expect(within(section).queryByText(/^UNRANKED/)).toBeNull();
  });

  it("answers an EMPTY ranked list with the empty state, never the children", async () => {
    route({ actions: [] });
    const { container } = await open();
    const section = screen.getByTestId("action-section");
    expect(within(section).queryByText(/^UNRANKED/)).toBeNull();
    const fold = container.querySelector("details[data-testid='prior-items']")!;
    expect(within(fold as HTMLElement).getByText(/^UNRANKED Z/)).toBeTruthy();
  });

  it("falls back to the legacy rail when the backend still says `decisions`", async () => {
    route({ actions: [], store: "decisions" });
    await open();
    expect(screen.getByText("Next steps")).toBeTruthy();
    expect(screen.getByText(/^UNRANKED Z/)).toBeTruthy();
  });

  it("keeps the layout and says it once, rather than guessing a rail", async () => {
    route({ fail: true });
    await open();
    expect(screen.getAllByTestId("channel-refresh-line")).toHaveLength(1);
    expect(screen.getByTestId("action-section")).toBeTruthy();
    expect(screen.queryByText(/^UNRANKED/)).toBeNull();
  });
});

describe("the money invariant an executable Meta card inherits", () => {
  it("offers the named change and a reasoned Dismiss, and no redo or revise", async () => {
    route({
      actions: [
        makeAction("pause_ad", {
          channel_slug: SLUG,
          title: "Pause the ad set with no conversions",
          executable: true,
          body: {
            action_label: "Pause",
            change_sentence: "Zavi pauses one ad set.",
            exact_change: { rows: [{ item: "Ad set", before: "Active", after: "Paused" }] },
          },
        }),
      ],
    });
    await open();
    const section = screen.getByTestId("action-section");
    const primary = Array.from(section.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Pause");
    expect(primary, "the named change must be a button").toBeTruthy();
    expect(within(section).queryByText("Approve")).toBeNull();
    expect(section.querySelector('[data-testid="card-footer"] button[aria-label="More actions"]')).toBeTruthy();
    expect(within(section).queryByTestId("post-text")).toBeNull();
    expect(within(section).queryByText(/redo|revise/i)).toBeNull();
    expect(within(section).queryByRole("menuitem", { name: /redo|revise/i })).toBeNull();
  });
});
