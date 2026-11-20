// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

import { useAgentDashboard } from "./dashboard-ui";

const fail = { ok: false, status: 502, json: async () => ({}) };
const calls = (needle: string) => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(needle));

let handle: ReturnType<typeof useAgentDashboard<unknown>> | null = null;
function Panel() {
  handle = useAgentDashboard<unknown>("seo");
  return null;
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retries the plain open on a 5xx", async () => {
  apiFetch.mockResolvedValue(fail);
  render(<Panel />);
  await waitFor(() => expect(handle?.loading).toBe(false));
  expect(calls("/api/agents/seo/dashboard")).toHaveLength(3);
  expect(calls("refresh=1")).toHaveLength(0);
});

it("sends a silent refresh=1 re-read exactly once on a 5xx", async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
  render(<Panel />);
  await waitFor(() => expect(handle?.loading).toBe(false));
  apiFetch.mockResolvedValue(fail);
  await act(async () => {
    handle!.refreshSilent!();
  });
  await waitFor(() => expect(calls("refresh=1").length).toBeGreaterThan(0));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(calls("refresh=1")).toHaveLength(1);
});

it("sends a manual (metered) refresh exactly once on a 5xx", async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
  render(<Panel />);
  await waitFor(() => expect(handle?.loading).toBe(false));
  apiFetch.mockResolvedValue(fail);
  await act(async () => {
    handle!.refresh();
  });
  await waitFor(() => expect(handle?.error).not.toBeNull());
  expect(calls("meter=1")).toHaveLength(1);
});
