// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { FIXTURES } from "./fixtures";

const GADS_PAYLOAD = {
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  prev_period: { from: "2026-07-21", to: "2026-08-19" },
  account: null,
  kpis: [
    {
      key: "spend",
      label: "Spend",
      value: 4820,
      prev: null,
      delta_pct: null,
      delta_abs: null,
      delta_good: null,
      unit: "usd",
    },
  ],
  campaigns: [],
  totals: null,
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
};

const ENDPOINT_METRIC = {
  key: "spend",
  value: 12345,
  unit: "usd",
  window_kind: "30d",
  day: "2026-09-18",
  grounded: true,
  prev_value: null,
  prev_day: null,
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function route(opts: { metrics?: unknown[]; dashboard?: () => unknown } = {}) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    if (url.includes("/metrics")) return ok({ metrics: opts.metrics ?? [] });
    if (url.includes("/dashboard")) return (opts.dashboard ?? (() => ok(GADS_PAYLOAD)))();
    throw new Error(`unexpected request: ${url}`);
  });
}

const urls = () => apiFetch.mock.calls.map((c) => String(c[0]));
const askedForADashboard = () => urls().some((u) => u.includes("/dashboard"));

function lane(slug: string) {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy rail</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={0}
      connected
      hasConnectors
    >
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

const spendCard = () => document.querySelector('[data-metric="spend"]');

beforeEach(() => {
  apiFetch.mockReset();
  spec.current = { name: "Google Ads", kpiFallback: "gads" };
});
afterEach(cleanup);

it("fills the headline row from the dashboard payload when the metrics endpoint is empty", async () => {
  route({ metrics: [] });
  const view = lane("kpi-gads-empty");
  await waitFor(() => expect(spendCard()).not.toBeNull());
  expect(spendCard()?.textContent).toContain("$4,820");
  expect(view.queryByTestId("metrics-empty")).toBeNull();
});

it("lets the metrics endpoint's rows win, and never reaches the adapter", async () => {
  route({ metrics: [ENDPOINT_METRIC] });
  lane("kpi-gads-rows");
  await waitFor(() => expect(spendCard()).not.toBeNull());
  expect(spendCard()?.textContent).toContain("$12,345");
  expect(spendCard()?.textContent).not.toContain("$4,820");
});

it("asks for no dashboard at all on a row that declares no kpiFallback", async () => {
  spec.current = { name: "Reddit" };
  route({ metrics: [] });
  const view = lane("kpi-none");
  await waitFor(() => expect(view.queryByTestId("channel-value-empty")).not.toBeNull());
  expect(askedForADashboard()).toBe(false);
  expect(view.getByText(FIXTURES.other.title)).toBeTruthy();
});

it("degrades to the empty sentence, with the action list intact, when the dashboard fetch fails", async () => {
  route({ metrics: [], dashboard: () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const view = lane("kpi-gads-dead");
  await waitFor(() => expect(view.queryByTestId("channel-value-empty")).not.toBeNull());
  expect(askedForADashboard()).toBe(true);
  expect(spendCard()).toBeNull();
  expect(view.getByText(FIXTURES.other.title)).toBeTruthy();
});
