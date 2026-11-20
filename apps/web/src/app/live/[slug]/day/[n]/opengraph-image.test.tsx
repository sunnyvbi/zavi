import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ data: null as unknown, fail: false }));
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(public element: ReactElement, public init: unknown) {}
  },
}));
vi.mock("@/lib/marketing/liveUpcar", async (orig) => ({
  ...(await orig<typeof import("@/lib/marketing/liveUpcar")>()),
  getLiveUpcar: async () => {
    if (h.fail) throw new Error("down");
    return h.data;
  },
}));

import Image, { size } from "./opengraph-image";
import { parseLiveUpcar } from "@/lib/marketing/liveUpcar";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
const day11 = {
  day: "2026-10-11", kind: "WORK", headline: "Started work on Meta Ads.", channels: [], work: [], why: null, budget: [],
  spent_usd: 708.36, bookings: 21, hosts: 3, published_at: null, updated_at: null,
};
const payload = (over: Record<string, unknown> = {}) =>
  parseLiveUpcar({
    run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { booking_value_usd: 300000 },
    bookings_estimate_factor: 1,
    numbers: {
      spent_usd: 7000, spend_per_day_recent_usd: 700, runs_out_day: 30, bookings: 300, hosts: 90, booking_value_usd: 100000,
      pace: { bookings_per_week: 83, hosts_per_week: 60, booking_value_per_week: 20000 },
      by_day: [],
    },
    now_line: { last_review_at: null, changes_today: 0, channels_today: [] },
    days: [day11],
    ...over,
  });
const text = async (n: string) => {
  const res = (await Image({ params: { slug: "upcar", n } })) as unknown as { element: ReactElement; init: unknown };
  expect(res.init).toEqual(size);
  return renderToStaticMarkup(res.element).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
};

beforeEach(() => {
  h.data = payload();
  h.fail = false;
});

describe("/live/<slug>/day/<n> share image", () => {
  it("shows the day, its headline and that day's spend and bookings", async () => {
    const t = await text("11");
    expect(t).toContain("Day 11 of 30");
    expect(t).toContain("Started work on Meta Ads.");
    expect(t).toContain("$708");
    expect(t).toContain("+21");
  });
  it("a day with no figures shows no stat boxes", async () => {
    h.data = payload({ days: [{ ...day11, spent_usd: null, bookings: null }] });
    const t = await text("11");
    expect(t).toContain("Day 11 of 30");
    expect(t).not.toContain("Ad spend");
  });
  it("unknown day, locked run, missing run or a down backend: the branded card, never an error", async () => {
    const cases: [() => void, string][] = [
      [() => (h.data = payload()), "12"],
      [() => (h.data = payload({ locked: true })), "11"],
      [() => (h.data = "not_found"), "11"],
      [() => (h.data = null), "11"],
      [() => (h.fail = true), "11"],
    ];
    for (const [set, n] of cases) {
      set();
      const t = await text(n);
      expect(t).toContain("An AI runs a real company's growth, in public.");
      expect(t).not.toMatch(/Day 1[12]/);
    }
  });
});
