// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { makeAction } from "../../actions/__tests__/fixtures";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../seo/SeoChannelPanel", () => ({ SeoChannelPanel: () => <div /> }));

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Answer => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500): Answer => ({ ok: false, status, json: async () => ({ error: { code: "boom" } }) });

const actionsQueue = new Map<string, Answer[]>();
const metricsQueue = new Map<string, Answer[]>();

function next(q: Map<string, Answer[]>, slug: string, fallback: Answer): Answer {
  const list = q.get(slug);
  if (!list || list.length === 0) return fallback;
  return list.length > 1 ? list.shift()! : list[0];
}

function install() {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method && init.method !== "GET") return ok({ ok: true });
    const m = u.match(/^\/api\/channels\/([a-z_]+)\/(actions|metrics|history)/);
    if (m) {
      const [, slug, what] = m;
      if (what === "actions") return next(actionsQueue, slug, ok({ actions: [], more: 0, store: "channel_actions" }));
      if (what === "metrics") return next(metricsQueue, slug, ok({ metrics: [] }));
      return ok({ runs: [], closed: [], pre_switch: [] });
    }
    return ok({});
  });
}

const listOf = (actions: ChannelActionView[]) => ok({ actions, more: 0, store: "channel_actions" });

const CHILDREN = <li>UNRANKED Z — legacy row</li>;

function channel(slug: string): Channel {
  const c = (CHANNELS as readonly Channel[]).find((x) => x.slug === slug);
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

function detail(slug: string): ChannelDetail {
  return {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: [],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
  };
}

function drawer(slug: string) {
  return (
    <ChannelDrawer
      detail={detail(slug)}
      actionCount={1}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    >
      {CHILDREN}
    </ChannelDrawer>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function open(slug: string) {
  const r = render(drawer(slug));
  await settle();
  return r;
}

const lines = () => screen.queryAllByTestId("channel-refresh-line");
const actionCalls = (slug: string) =>
  apiFetch.mock.calls.filter((c) => String(c[0]).startsWith(`/api/channels/${slug}/actions`));

beforeEach(() => {
  apiFetch.mockReset();
  actionsQueue.clear();
  metricsQueue.clear();
  install();
});
afterEach(cleanup);

const SHAPES = ["x_organic", "seo", "instagram_organic", "meta_ads"] as const;

describe.each(SHAPES)("%s: a failed read keeps the page", (slug) => {
  const card = (title: string) => makeAction("check", { channel_slug: slug, title });

  it("a transient failure then success shows the cards and no line", async () => {
    actionsQueue.set(slug, [fail(503), listOf([card(`${slug} CARD ONE`)])]);
    await open(slug);
    expect(screen.getByText(`${slug} CARD ONE`)).toBeTruthy();
    expect(lines()).toHaveLength(0);
    expect(actionCalls(slug)).toHaveLength(2);
  });

  it("three failures keep the layout, with empty slots and ONE line", async () => {
    actionsQueue.set(slug, [fail(500)]);
    await open(slug);
    expect(actionCalls(slug)).toHaveLength(3);
    expect(lines()).toHaveLength(1);
    expect(document.querySelector('[data-section="snapshot"]')).not.toBeNull();
    const section = screen.getByTestId("action-section");
    expect(section.querySelectorAll("article")).toHaveLength(0);
    expect(screen.queryByText(/^UNRANKED/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/could not load these actions/i);
    expect(document.body.textContent).not.toMatch(/could not read this channel/i);
  });

  it("a refresh that fails with cards on screen keeps the cards and shows the line", async () => {
    actionsQueue.set(slug, [listOf([card(`${slug} KEPT CARD`)])]);
    metricsQueue.set(slug, [fail(502)]);
    await open(slug);
    expect(screen.getByText(`${slug} KEPT CARD`)).toBeTruthy();
    expect(lines()).toHaveLength(1);

    actionsQueue.set(slug, [fail(500)]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await settle();
    expect(screen.getByText(`${slug} KEPT CARD`)).toBeTruthy();
    expect(lines()).toHaveLength(1);
  });

  it("Try again that succeeds clears the line", async () => {
    actionsQueue.set(slug, [fail(500)]);
    await open(slug);
    expect(lines()).toHaveLength(1);
    actionsQueue.set(slug, [listOf([card(`${slug} BACK`)])]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await settle();
    expect(screen.getByText(`${slug} BACK`)).toBeTruthy();
    expect(lines()).toHaveLength(0);
  });
});

describe("switching channels after a failure", () => {
  it("never shows the previous channel's cards", async () => {
    actionsQueue.set("x_organic", [listOf([makeAction("check", { channel_slug: "x_organic", title: "X ONLY CARD" })])]);
    actionsQueue.set("meta_ads", [fail(500)]);
    const r = await open("x_organic");
    expect(screen.getByText("X ONLY CARD")).toBeTruthy();

    actionsQueue.set("x_organic", [fail(500)]);
    r.rerender(drawer("meta_ads"));
    await settle();
    expect(screen.queryByText("X ONLY CARD")).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(screen.getByTestId("action-section").querySelectorAll("article")).toHaveLength(0);
  });
});
