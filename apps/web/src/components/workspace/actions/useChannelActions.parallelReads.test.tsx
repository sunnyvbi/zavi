// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { useChannelActions } from "./useChannelActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
const okRes = (body: unknown): Res => ({ ok: true, status: 200, json: async () => body });

function deferred() {
  let resolve!: (r: Res) => void;
  const promise = new Promise<Res>((r) => (resolve = r));
  return { promise, resolve };
}

const card = {
  id: "a1",
  channel_slug: "meta_ads",
  status: "pending",
  title: "Raise the budget",
  body: {},
};

let seen: { loading: boolean; metricsLoading: boolean; ids: string[]; metrics: number } | null = null;

function Probe() {
  const c = useChannelActions("meta_ads");
  seen = { loading: c.loading, metricsLoading: c.metricsLoading, ids: c.actions.map((a) => a.id), metrics: c.metrics.length };
  return null;
}

const metric = { key: "spend", value: 12, unit: "usd", window_kind: "day", day: "2026-11-04", grounded: true, prev_value: null, prev_day: null };

beforeEach(() => {
  apiFetch.mockReset();
  seen = null;
});
afterEach(cleanup);

it("shows the cards while the numbers are still being read", async () => {
  const metrics = deferred();
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return metrics.promise;
    return Promise.resolve(okRes({ actions: [card], more: 0, store: "channel_actions", completed: [] }));
  });
  await act(async () => {
    render(<Probe />);
  });

  const paths = apiFetch.mock.calls.map((c) => String(c[0]));
  expect(paths.some((p) => p.includes("/actions"))).toBe(true);
  expect(paths.some((p) => p.includes("/metrics"))).toBe(true);
  expect(seen?.loading).toBe(false);
  expect(seen?.ids).toEqual(["a1"]);
  expect(seen?.metricsLoading).toBe(true);

  await act(async () => {
    metrics.resolve(okRes({ metrics: [metric] }));
  });
  expect(seen?.metricsLoading).toBe(false);
  expect(seen?.metrics).toBe(1);
  expect(seen?.ids).toEqual(["a1"]);
});

it("shows the numbers while the cards are still being read", async () => {
  const actions = deferred();
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return Promise.resolve(okRes({ metrics: [metric] }));
    return actions.promise;
  });
  await act(async () => {
    render(<Probe />);
  });
  expect(seen?.metricsLoading).toBe(false);
  expect(seen?.metrics).toBe(1);
  expect(seen?.loading).toBe(true);

  await act(async () => {
    actions.resolve(okRes({ actions: [card], more: 0, store: "channel_actions", completed: [] }));
  });
  expect(seen?.loading).toBe(false);
  expect(seen?.ids).toEqual(["a1"]);
});
