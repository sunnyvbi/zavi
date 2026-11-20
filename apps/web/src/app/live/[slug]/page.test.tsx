import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ data: null as unknown, slug: "upcar" }));
vi.mock("@/components/marketing/growth-home/GrowthHeader", () => ({ GrowthHeader: () => null }));
vi.mock("@/components/marketing/growth-home/GrowthFooter", () => ({ GrowthFooter: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/marketing/pricing", async (orig) => {
  const real = await orig<typeof import("@/lib/marketing/pricing")>();
  return { ...real, getLivePricing: async () => real.PRICING_FALLBACK };
});
vi.mock("@/lib/resolveCta", () => ({ resolveMarketingSession: async () => ({ cta: { href: "/start", label: "Start" }, email: null }) }));
vi.mock("@/lib/marketing/liveUpcar", async (orig) => ({
  ...(await orig<typeof import("@/lib/marketing/liveUpcar")>()),
  getLiveUpcar: async () => h.data,
}));

import LiveRunPage from "./page";
import { parseLiveUpcar } from "@/lib/marketing/liveUpcar";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-13T09:00:00-04:00", end_at: "2026-10-30T23:59:59-04:00" };
const day = { day: "2026-10-03", kind: "WIN", headline: "My Meta host ad works. Doubled its budget.", channels: ["Meta"], work: ["Compared the two host ads"], why: "Hosts at $28 each.", budget: [{ channel: "Meta", from_usd: 150, to_usd: 300 }], spent_usd: 640, bookings: 15, hosts: 18 };
const text = async () => renderToStaticMarkup(await LiveRunPage({ params: Promise.resolve({ slug: h.slug }) })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => { h.data = null; h.slug = "upcar"; });

describe("/live/upcar page", () => {
  it("?day=1 shows day 1's totals and log only, with no live 'Zavi now' line", async () => {
    const c = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
    const r = (d: string, spent: number, v: number) => ({ day: d, bookings: 5, hosts: 1, spent_usd: spent, booking_value_usd: v });
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: false, clock: c, budget_usd: 25000, goals: { booking_value_usd: 300000 }, numbers: { spent_usd: 1800, spend_per_day_recent_usd: 600, runs_out_day: 30, bookings: 15, hosts: 3, booking_value_usd: 111111, pace: { bookings_per_week: 150, hosts_per_week: 84, booking_value_per_week: 53385 }, by_day: [r("2026-10-01", 300, 4321), r("2026-10-02", 500, 5000), r("2026-10-03", 1000, 101790)] }, now_line: { last_review_at: "2026-10-03T14:00:00Z", changes_today: 1, channels_today: [] }, days: [{ ...day, day: "2026-10-03", headline: "Day three entry." }, { ...day, day: "2026-10-01", headline: "Day one entry." }] });
    const t = renderToStaticMarkup(await LiveRunPage({ params: Promise.resolve({ slug: "upcar" }), searchParams: Promise.resolve({ day: "1" }) })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(t).toContain("$4,321 / $300,000");
    expect(t).toContain("Day one entry.");
    expect(t).not.toContain("Day three entry.");
    expect(t).toContain("Day 1/30");
    expect(t).not.toContain("Zavi now");
  });
  it("locked: no dollar figure except the $25,000 limit", async () => {
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: true, clock, budget_usd: 25000, goals: { bookings: 600, hosts: 500 }, numbers: null, now_line: { last_review_at: null, changes_today: 0, channels_today: [] }, days: [{ ...day, kind: "WORK", headline: "Changed a Meta budget.", why: null, budget: [{ channel: "Meta", from_usd: null, to_usd: null }], spent_usd: null, bookings: null, hosts: null }] });
    const t = await text();
    expect(t).toContain("Changed a Meta budget.");
    const runDollars = (t.match(/\$[0-9][0-9,]*(\/mo)?/g) ?? []).filter((m) => !m.endsWith("/mo"));
    expect(runDollars.every((m) => m === "$25,000")).toBe(true);
  });
  it("unlocked: counts, goals and a published day", async () => {
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { bookings: 600, hosts: 500 }, numbers: { spent_usd: 9840, spend_per_day_recent_usd: 970, runs_out_day: 29, bookings: 220, hosts: 259, pace: { bookings_per_week: 119, hosts_per_week: 118 }, by_day: [] }, now_line: { last_review_at: null, changes_today: 0, channels_today: [] }, days: [day] });
    const t = await text();
    expect(t).toContain("220 / 600");
    expect(t).toContain("259 / 500");
    expect(t).toContain("My Meta host ad works.");
    expect(t).toContain("$15,160");
    expect(t).toContain("Run Zavi on my site");
    expect(t).toContain("Starter $20/mo");
  });
  it("a dollar goal leads: $ booked vs the goal, and no dollar bar without one", async () => {
    const raw = { run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { bookings: 600, hosts: 500, booking_value_usd: 300000 }, numbers: { spent_usd: 9840, spend_per_day_recent_usd: 970, runs_out_day: 29, bookings: 220, hosts: 259, booking_value_usd: 123456, pace: { bookings_per_week: 119, hosts_per_week: 118, booking_value_per_week: 38000 }, by_day: [] }, now_line: { last_review_at: null, changes_today: 0, channels_today: [] }, days: [] };
    h.data = parseLiveUpcar(raw);
    const t = await text();
    expect(t).toContain("Bookings ($)");
    expect(t).toContain("$123,456 / $300,000");
    expect(t).toContain("not profit");
    h.data = parseLiveUpcar({ ...raw, goals: { bookings: 600, hosts: 500 } });
    expect(await text()).not.toContain("Bookings ($)");
    h.data = parseLiveUpcar({ ...raw, goals: { booking_value_usd: 300000 } });
    const only = await text();
    expect(only).not.toContain("Bookings made");
    expect(only).not.toContain("New hosts");
    expect(only).not.toContain("220 / 600");
  });
  it("a 3-day $500 test run labels itself from its own dates", async () => {
    h.slug = "upcar-test";
    h.data = parseLiveUpcar({ run: { slug: "upcar-test", listed: false }, locked: false, clock: { start_at: "2026-09-28T09:00:00-04:00", unlock_at: "2026-09-28T09:00:00-04:00", end_at: "2026-09-30T23:59:59-04:00" }, budget_usd: 500, goals: { bookings: 40, hosts: 30 }, numbers: { spent_usd: 160, spend_per_day_recent_usd: 0, runs_out_day: null, bookings: 10, hosts: 8, pace: { bookings_per_week: 119, hosts_per_week: 118 }, by_day: [] }, now_line: { last_review_at: null, changes_today: 0, channels_today: [] }, days: [] });
    const t = await text();
    expect(t).toContain("$500 to spend");
    expect(t).toContain("3 days");
    expect(t).toContain("Mon 28 Sep");
    expect(t).toContain("Wed 30 Sep");
    expect(t).not.toMatch(/Thu 1 Oct|Fri 30 Oct|\$25,000/);
    expect(t).not.toContain("Numbers public");
  });
  describe("after the end date", () => {
    const past = { start_at: "2020-01-01T00:00:00-05:00", unlock_at: "2020-01-01T00:00:00-05:00", end_at: "2020-01-30T23:59:59-05:00" };
    const raw = { run: { slug: "upcar", listed: true }, locked: false, clock: past, budget_usd: 28400, budget_raise: { on: "2020-01-24", start_usd: 25000 }, goals: { booking_value_usd: 300000 }, numbers: { spent_usd: 27567, spend_per_day_recent_usd: 900, runs_out_day: 31, bookings: 220, hosts: 259, booking_value_usd: 123456, pace: { bookings_per_week: 119, hosts_per_week: 118, booking_value_per_week: 38000 }, by_day: [] }, now_line: { last_review_at: "2020-01-30T12:00:00Z", changes_today: 0, channels_today: [] }, days: [] };

    it("says Finished, with the raised limit and its date, and nothing that is still running", async () => {
      h.data = parseLiveUpcar(raw);
      const t = await text();
      expect(t).toContain("Finished");
      expect(t).toContain("Zavi ran growth for Upcar");
      expect(t).toContain("$28,400 limit since Fri 24 Jan");
      expect(t).toContain("$25,000 of real ad money to start, $28,400 since Fri 24 Jan");
      expect(t).toContain("$833");
      for (const gone of ["Zavi is running growth", "We're not steering it", "Zavi now", "At today's pace", "runs out", "this week"]) expect(t).not.toContain(gone);
    });

    it("no ping or pulse is left", async () => {
      h.data = parseLiveUpcar(raw);
      const html = renderToStaticMarkup(await LiveRunPage({ params: Promise.resolve({ slug: "upcar" }) }));
      expect(html).not.toContain("animate-ping");
      expect(html).not.toContain("animate-pulse");
    });

    it("a run still going keeps its Live badge and its old budget words", async () => {
      h.data = parseLiveUpcar({ ...raw, clock: { ...past, end_at: "2099-01-30T23:59:59-05:00" }, budget_raise: null });
      const t = await text();
      expect(t).toContain("Live");
      expect(t).toContain("hard limit");
      expect(t).toContain("$28,400 of real ad money for the whole run");
      expect(t).toContain("Zavi is running growth");
    });
  });
  it("an unknown or private run is a 404", async () => {
    h.data = "not_found";
    await expect(LiveRunPage({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("backend down: unavailable, and no run facts (no fake $25,000 run)", async () => {
    const t = await text();
    expect(t).toContain("This page is temporarily unavailable.");
    expect(t).not.toMatch(/\$25,000|30 days|\d+ \/ 600/);
  });
  it("always shows the required disclosures, and no em dashes in source", async () => {
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: true, clock, budget_usd: 25000, goals: { bookings: 600, hosts: 500 }, numbers: null, now_line: { last_review_at: null, changes_today: 0, channels_today: [] }, days: [] });
    const t = await text();
    for (const s of ["$25,000", "We won't pause it or override it", "channels below. It places ads and moves budget only on the accounts Upcar has connected", "Upcar is run by Zavi's founder, so the money and the results are real."]) expect(t).toContain(s);
    expect(t).not.toMatch(/No pause button|Every decision public|every dollar/i);
    const dir = __dirname;
    for (const f of ["page.tsx", "_components/DayLog.tsx", "_components/Gauges.tsx", "_components/Countdown.tsx", "_components/format.ts", "_components/ChannelBoard.tsx", "_components/channels.ts"]) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toContain("—");
    }
  });
});

describe("/live channel board", () => {
  it("has a two-sentence pitch for every live registry channel", async () => {
    const { CHANNELS: ALL_CHANNELS, RETIRED_CHANNEL_SLUGS } = await import("@zavi/shared");
    const CHANNELS = ALL_CHANNELS.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.slug));
    const { PITCH } = await import("./_components/channels");
    for (const c of CHANNELS) {
      const line = PITCH[c.slug];
      expect(line, c.slug).toBeTruthy();
      expect(line!.split(/(?<=\.)\s+/).length, c.slug).toBe(2);
    }
    const { BOARD } = await import("./_components/channels");
    expect(BOARD.flatMap((g) => g.channels).length).toBe(CHANNELS.length);
    expect(BOARD.some((g) => g.label === "More")).toBe(false);
  });
  it("the mission log links only days that have their own page", async () => {
    const c = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: false, clock: c, budget_usd: 25000, goals: { booking_value_usd: 300000 }, numbers: null, now_line: {}, days: [{ ...day, day: "2026-09-30", headline: "Early." }] });
    expect(renderToStaticMarkup(await LiveRunPage({ params: Promise.resolve({ slug: "upcar" }) }))).not.toContain("/live/upcar/day/");
    h.data = parseLiveUpcar({ run: { slug: "upcar", listed: true }, locked: false, clock: c, budget_usd: 25000, goals: { booking_value_usd: 300000 }, numbers: null, now_line: {}, days: [{ ...day, day: "2026-10-03" }] });
    expect(renderToStaticMarkup(await LiveRunPage({ params: Promise.resolve({ slug: "upcar" }) }))).toContain('href="/live/upcar/day/3"');
  });
});
