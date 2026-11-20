// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LiveStatsStrip } from "./LiveStatsStrip";
import { UpcarLiveTiles } from "./UpcarLiveTiles";
import { LIVE_STATS_STORAGE_KEY, resetLiveStatsForTests } from "@/lib/marketing/liveStats";

const STORED = {
  as_of: "2026-09-22T12:00:00.000Z",
  metrics: {
    tokens_processed: { value: 1234567, rate_per_sec: 10 },
    agent_steps: { value: 400, rate_per_sec: 0.0005 },
  },
};

beforeEach(() => {
  resetLiveStatsForTests();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("live surfaces", () => {
  it("render nothing when there is no data", async () => {
    const { container } = render(
      <>
        <LiveStatsStrip />
        <UpcarLiveTiles />
      </>,
    );
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("render the stored numbers when the fetch fails", async () => {
    window.localStorage.setItem(LIVE_STATS_STORAGE_KEY, JSON.stringify(STORED));
    const { getByTestId } = render(
      <>
        <LiveStatsStrip />
        <UpcarLiveTiles />
      </>,
    );
    await settle();
    expect(getByTestId("live-stats-strip").textContent).toContain("1,234,567 tokens processed");
    const tiles = getByTestId("upcar-live-tiles").textContent ?? "";
    expect(tiles).toContain("1,234,567");
    expect(tiles).toContain("400");
    expect(tiles).toContain("across Zavi");
    expect(tiles).not.toContain("live across Zavi");
    expect(getByTestId("upcar-live-tiles").querySelector(".tabular-nums")).not.toBeNull();
  });
});
