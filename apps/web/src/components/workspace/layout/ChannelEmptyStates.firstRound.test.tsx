// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const apiFetch = vi.hoisted(() =>
  vi.fn(async (_path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ run_id: "run-12345678" }) };
    return { ok: true, status: 200, json: async () => ({ channels: [] }) };
  }),
);
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ActionsEmpty, StaleSignupBanner, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelPlanLockProvider } from "../actions/channelPlanLock";

afterEach(() => {
  cleanup();
  apiFetch.mockClear();
});

const run: ChannelRunInfo = { slug: "seo", name: "SEO", switched: false, priorCount: 0, foldBelow: false, onRan: () => {} };
const posts = () => apiFetch.mock.calls.filter((c) => c[1]?.method === "POST");

function locked(ui: ReactNode, upgrade = vi.fn(), tierName: string | null = "Starter") {
  render(<ChannelPlanLockProvider value={{ tierName, upgrade }}>{ui}</ChannelPlanLockProvider>);
  return upgrade;
}

describe("every first-round card is closed", () => {
  it("says the round is over and offers the plan, with no Run button", () => {
    const upgrade = locked(<ActionsEmpty workState="delivered" lastRunAt="2026-10-13T10:00:00Z" run={run} />);
    const state = screen.getByTestId("empty-first-round-done");
    expect(state.textContent).toContain("That was your first roundOn Starter, Zavi finds new steps every week.");
    expect(document.body.textContent).not.toContain("found nothing");
    expect(screen.queryByTestId("run-channel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Starter" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it("names the plan the lock names", () => {
    locked(<ActionsEmpty workState="idle" lastRunAt={null} run={run} />, vi.fn(), "Pro");
    expect(screen.getByTestId("empty-first-round-done").textContent).toContain("On Pro, Zavi finds new steps every week.");
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  });

  it("an open channel explains its empty queue and keeps Run it again", async () => {
    locked(<ActionsEmpty workState="delivered" lastRunAt="2026-10-13T10:00:00Z" run={run} />, vi.fn(), null);
    expect(screen.queryByTestId("empty-first-round-done")).toBeNull();
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get suggestions" })).toBeTruthy();
  });
});

describe("run buttons on a channel the plan does not include", () => {
  it("a failed run's Run it again opens the upgrade and starts nothing", () => {
    const upgrade = locked(<ActionsEmpty workState="needs_review" lastRunAt={null} run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it("the stale signup banner's Refresh opens the upgrade and starts nothing", () => {
    const upgrade = locked(<StaleSignupBanner run={run} weeks={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });
});
