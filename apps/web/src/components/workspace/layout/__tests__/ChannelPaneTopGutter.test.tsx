// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

import { ChannelDetailPage } from "../ChannelDrawer";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
});

const SPACING: Record<string, number> = {
  "0": 0,
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "5": 20,
  "6": 24,
  "7": 28,
  "8": 32,
};

function edgeOf(
  className: string,
  kind: "p" | "m",
  sides: string[],
  wide = false,
): number {
  let px = 0;
  for (const raw of className.split(/\s+/)) {
    const token =
      wide && raw.startsWith("sm:[&:has(>*:not(:empty))]:")
        ? raw.slice("sm:[&:has(>*:not(:empty))]:".length)
        : raw;
    if (token.includes(":")) continue;
    const match = /^(p|m)([trblxy]?)-(.+)$/.exec(token);
    if (!match) continue;
    if (match[1] !== kind) continue;
    if (!sides.includes(match[2])) continue;
    const value = SPACING[match[3]];
    if (value === undefined) throw new Error(`unmapped spacing token: ${token}`);
    px = value;
  }
  return px;
}

const detail = (slug: string): ChannelDetail => ({
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!,
  mode: "produce",
  connected: true,
  connectors: ["reddit"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});

async function mountPage(slug: string) {
  const view = render(
    <ChannelDetailPage
      detail={detail(slug)}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    />,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  return view;
}

describe("the channel pane's gutter under its header rule", () => {
  it("does not stack the body's top padding on top of the header row's own margin", async () => {
    const { container } = await mountPage("reddit_organic");

    const body = container.querySelector<HTMLElement>(".ws-scroll")!;
    const row = screen.getByTestId("channel-header");

    const side = edgeOf(body.className, "p", ["x"]);
    const top =
      edgeOf(body.className, "p", ["t", "y"]) +
      edgeOf(row.className, "m", ["t", "y"], true);

    expect(side).toBe(24);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(side);
  });

  it("keeps the header row as the first thing in the body, so the two spacings add up", async () => {
    const { container } = await mountPage("reddit_organic");

    const body = container.querySelector<HTMLElement>(".ws-scroll")!;
    const row = screen.getByTestId("channel-header");

    expect(body.contains(row)).toBe(true);
    expect(row.parentElement!.firstElementChild).toBe(row);
    expect(row.parentElement!.parentElement).toBe(body);
  });

  it("gives the phone its own gutter, carried by the body alone", async () => {
    const { container } = await mountPage("reddit_organic");

    const body = container.querySelector<HTMLElement>(".ws-scroll")!;
    const row = screen.getByTestId("channel-header");

    const phoneTop = body.className.match(/compact:pt-(\d+)/);
    expect(phoneTop, "the phone needs its own top gutter token").not.toBeNull();
    expect(Number(phoneTop![1])).toBeGreaterThan(0);
    expect(row.className).not.toMatch(/compact:mt-\d/);
    expect(row.className).not.toMatch(/(?<![\w:-])mt-\d/);
    expect(edgeOf(row.className, "m", ["t", "y"])).toBe(0);
  });
});
