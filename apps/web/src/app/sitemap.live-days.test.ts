import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-host": "www.zaviagent.com" }) }));
const h = vi.hoisted(() => ({ pill: "upcar" as string | null, data: null as unknown, fail: false, pillOpts: undefined as unknown }));
vi.mock("@/lib/marketing/liveUpcar", async (orig) => ({
  ...(await orig<typeof import("@/lib/marketing/liveUpcar")>()),
  getLivePillSlug: async (opts: unknown) => {
    h.pillOpts = opts;
    return h.pill;
  },
  getLiveUpcar: async () => {
    if (h.fail) throw new Error("boom");
    return h.data;
  },
}));

import sitemap from "./sitemap";
import { parseLiveUpcar } from "@/lib/marketing/liveUpcar";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
const entry = (day: string) => ({ day, kind: "CHANGE", headline: `Entry ${day}`, channels: [], work: [], why: null, budget: [], spent_usd: 1, bookings: 1, hosts: 1, updated_at: `${day}T23:00:00.000Z` });
const payload = (over: Record<string, unknown> = {}) =>
  parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { booking_value_usd: 1 }, numbers: null, now_line: {}, days: [entry("2026-10-09"), entry("2026-10-01")], ...over });
const dayUrls = async () => (await sitemap()).map((e) => e.url).filter((u) => u.includes("/day/"));

beforeEach(() => {
  h.pill = "upcar";
  h.data = payload();
  h.fail = false;
});

describe("sitemap: live stunt day pages", () => {
  it("keeps a finished run's day pages: the Live pill stopping doesn't drop them", async () => {
    await dayUrls();
    expect(h.pillOpts).toEqual({ evenIfEnded: true });
  });
  it("lists every published day of the featured run", async () => {
    expect(await dayUrls()).toEqual(["https://www.zaviagent.com/live/upcar/day/1", "https://www.zaviagent.com/live/upcar/day/9"]);
  });
  it("lists none for an unlisted or locked run, or with no featured run", async () => {
    h.data = payload({ run: { slug: "upcar", listed: false } });
    expect(await dayUrls()).toEqual([]);
    h.data = payload({ locked: true });
    expect(await dayUrls()).toEqual([]);
    h.pill = null;
    expect(await dayUrls()).toEqual([]);
  });
  it("a backend error or outage drops only the day URLs, never the sitemap", async () => {
    h.fail = true;
    const all = await sitemap();
    expect(all[0]?.url).toBe("https://www.zaviagent.com/");
    expect(all.some((e) => e.url.includes("/day/"))).toBe(false);
    h.fail = false;
    h.data = null;
    expect(await dayUrls()).toEqual([]);
  });
  it("a backend that never answers is cut off at the deadline", async () => {
    vi.useFakeTimers();
    h.data = new Promise(() => {});
    const p = sitemap();
    await vi.advanceTimersByTimeAsync(3_100);
    const all = await p;
    vi.useRealTimers();
    expect(all.some((e) => e.url.includes("/day/"))).toBe(false);
    expect(all.length).toBeGreaterThan(10);
  });
});
