// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { linkedin_ads } from "../platforms/linkedin_ads";
import { reddit_ads } from "../platforms/reddit_ads";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, clone() { return this; } });

let releaseChannels: () => void = () => {};

function route(slug: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  releaseChannels = release;
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.startsWith("/api/channels") && !u.includes(`/api/channels/${slug}`)) {
      await gate;
      return ok({ channels: [{ channel_slug: slug, run_reserve_credits: 340, last_run_id: null }] });
    }
    return ok({ metrics: [] });
  });
}

function lane(slug: string) {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={0}
      connected
      hasConnectors
      planIntent="Reach founders and heads of growth at B2B companies with a lead form."
      planRationale="Your buyers are on LinkedIn."
    >
      {null}
    </ChannelActionsLane>,
  );
}

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("LinkedIn Ads run cost line", () => {
  it("shows Run LinkedIn Ads now with no loading cost and no Uses ~N credits, before or after the hold loads", async () => {
    spec.current = linkedin_ads;
    route("linkedin_ads");
    lane("linkedin_ads");
    const run = await screen.findByTestId("run-channel");
    expect(run.textContent).toBe("Get suggestions");
    expect(screen.getByText(/Reach founders and heads of growth/)).toBeTruthy();
    expect(screen.queryByTestId("run-cost")).toBeNull();
    expect(screen.queryByTestId("run-cost-slot")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Loading what a run costs/);
    await act(async () => releaseChannels());
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/channels") && !String(u).includes("/api/channels/linkedin_ads"))).toBe(true),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("run-channel").textContent).toBe("Get suggestions");
    expect(screen.queryByTestId("run-cost")).toBeNull();
    expect(screen.queryByTestId("run-cost-slot")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Uses\s*~?\d[\d,]*\s*credits|Uses credits from your plan|About \d+ credits|Loading what a run costs/);
  });

  it("another channel still shows its loading cost, then About 340 credits", async () => {
    spec.current = reddit_ads;
    route("reddit_ads");
    lane("reddit_ads");
    await screen.findByTestId("run-channel");
    const loading = screen.getByTestId("run-cost");
    expect(loading.textContent).toBe("Loading what a run costs");
    await act(async () => releaseChannels());
    await waitFor(() => expect(screen.getByTestId("run-cost").textContent).toBe("About 340 credits"));
  });
});
