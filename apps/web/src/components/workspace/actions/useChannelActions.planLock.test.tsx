// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "./channelPlanLock";
import { makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const planRefusal = () =>
  Promise.resolve({
    ok: false,
    status: 403,
    json: async () => ({
      error: { code: "plan_upgrade_required", required_tier: "starter", message: "This needs the Starter plan." },
    }),
  });

const card = makeAction("fix", { id: "ca-1", channel_slug: "seo" });
const PLAN = { id: "plan-1", title: "Plan", content: "Do this", proposed_at: "2026-10-13T10:00:00Z", status: "pending" };
let writeAnswer: () => Promise<unknown> = () => ok({ ok: true });

function route() {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") return writeAnswer();
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: [card], more: 0, store: "channel_actions", plan: PLAN });
  });
}

const writes = () =>
  apiFetch.mock.calls
    .filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST")
    .map((c) => String(c[0]));

async function mount(lock: ChannelPlanLock | null, slug = "seo") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ChannelPlanLockProvider value={lock}>{children}</ChannelPlanLockProvider>
  );
  const view = renderHook(() => useChannelActions(slug), { wrapper });
  await waitFor(() => expect(view.result.current.actions).toHaveLength(1));
  return view;
}

beforeEach(() => {
  apiFetch.mockReset();
  writeAnswer = () => ok({ ok: true });
  route();
});
afterEach(cleanup);

describe("a channel the plan does not include", () => {
  it("Redo, Approve and a plan change open the upgrade and call nothing", async () => {
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: "Starter", upgrade });
    await act(async () => {
      await result.current.handlers.onRedo(card, "shorter");
    });
    expect(upgrade).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.handlers.onApprove!(card);
    });
    expect(upgrade).toHaveBeenCalledTimes(2);
    let changed = true;
    await act(async () => {
      changed = await result.current.changePlan("more video");
    });
    expect(changed).toBe(false);
    expect(upgrade).toHaveBeenCalledTimes(3);
    expect(writes()).toEqual([]);
    expect(result.current.redoState).toEqual({});
    expect(result.current.notice).toBeNull();
  });

  it("Done, Not now and Reject still write", async () => {
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: "Starter", upgrade });
    for (const status of ["acted", "snoozed", "rejected"] as const) {
      await act(async () => {
        await result.current.handlers.onSetStatus(card, status);
      });
    }
    expect(writes()).toEqual([
      "/api/channel-actions/ca-1",
      "/api/channel-actions/ca-1",
      "/api/channel-actions/ca-1",
    ]);
    const sent = apiFetch.mock.calls
      .filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST")
      .map((c) => (JSON.parse(String((c[1] as { body: string }).body)) as { action: string }).action);
    expect(sent).toEqual(["acted", "snoozed", "rejected"]);
    expect(upgrade).not.toHaveBeenCalled();
  });
});

describe("a LinkedIn Ads pause after a downgrade", () => {
  it("Approve sends the pause, the one write the server lets through, and opens no upgrade", async () => {
    const pause = makeAction("pause_ad", { id: "li-pause", channel_slug: "linkedin_ads", executable: true });
    apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === "POST") return writeAnswer();
      if (String(path).includes("/metrics")) return ok({ metrics: [] });
      return ok({ actions: [pause], more: 0, store: "channel_actions" });
    });
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: "Pro", upgrade }, "linkedin_ads");
    let approved: unknown = false;
    await act(async () => {
      approved = await result.current.handlers.onApprove!(pause);
    });
    expect(writes()).toEqual(["/api/channel-actions/li-pause/approve"]);
    expect(approved).toBe(true);
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("a LinkedIn launch on the same locked page still opens the upgrade and sends nothing", async () => {
    const launch = makeAction("update_ad", { id: "li-launch", channel_slug: "linkedin_ads", executable: true });
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: "Pro", upgrade }, "linkedin_ads");
    await act(async () => {
      await result.current.handlers.onApprove!(launch);
    });
    expect(writes()).toEqual([]);
    expect(upgrade).toHaveBeenCalledTimes(1);
  });
});

describe("the server refuses with plan_upgrade_required", () => {
  it("opens the upgrade for the tier it named, with no error line", async () => {
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: null, upgrade });
    writeAnswer = planRefusal;
    let started: unknown = true;
    await act(async () => {
      started = await result.current.handlers.onRedo(card, "shorter");
    });
    expect(writes()).toEqual(["/api/channel-actions/ca-1/redo"]);
    expect(started).toBe(false);
    expect(upgrade).toHaveBeenCalledWith("starter");
    expect(result.current.notice).toBeNull();
    expect(result.current.redoState).toEqual({});
  });

  it("on a surface with no upgrade path, the server's sentence is shown as before", async () => {
    const { result } = await mount(null);
    writeAnswer = planRefusal;
    await act(async () => {
      await result.current.handlers.onApprove!(card);
    });
    expect(result.current.notice).toBe("This needs the Starter plan.");
  });
});

describe("an open channel", () => {
  it("Redo and Approve call the backend as before", async () => {
    const upgrade = vi.fn();
    const { result } = await mount({ tierName: null, upgrade });
    await act(async () => {
      await result.current.handlers.onRedo(card, "shorter");
    });
    await act(async () => {
      await result.current.handlers.onApprove!(card);
    });
    expect(writes()).toEqual(["/api/channel-actions/ca-1/redo", "/api/channel-actions/ca-1/approve"]);
    expect(upgrade).not.toHaveBeenCalled();
  });
});
