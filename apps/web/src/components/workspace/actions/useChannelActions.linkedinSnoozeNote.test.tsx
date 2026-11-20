// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

const mount = async (slug: string) => {
  const card = makeAction("pause_ad", { id: "ca-1", channel_slug: slug });
  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") return ok({});
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: [card], more: 0, store: "channel_actions", plan: null });
  });
  const hook = renderHook(() => useChannelActions(slug));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  return { hook, card };
};

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("Not now on LinkedIn Ads", () => {
  it("hides the card with no 'Hidden for now' line, while other channels keep it", async () => {
    const li = await mount("linkedin_ads");
    await act(async () => {
      expect(await li.hook.result.current.handlers.onSetStatus(li.card, "snoozed", { until: "2026-12-01T00:00:00Z" })).toBe(true);
    });
    expect(li.hook.result.current.notice).toBeNull();
    await waitFor(() => expect(li.hook.result.current.actions).toHaveLength(0));
    cleanup();
    const meta = await mount("meta_ads");
    await act(async () => {
      await meta.hook.result.current.handlers.onSetStatus(meta.card, "snoozed", { until: "2026-12-01T00:00:00Z" });
    });
    expect(meta.hook.result.current.notice).toBe("Hidden for now. It comes back on its own.");
  });
});
