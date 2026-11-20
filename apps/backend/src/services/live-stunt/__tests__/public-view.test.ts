import { describe, it, expect } from "vitest";
import { toPublicPayload, type StoredDay } from "../public-view";
import { realRun } from "./fixtures";
import { liveRunsRejection } from "../config";
import type { StuntSnapshot } from "../snapshot";

const cfg = realRun();
const snap: StuntSnapshot = {
  taken_at: "2026-10-13T20:00:00Z", day: 13, pace: { bookings_per_week: 119, hosts_per_week: 118 },
  last_review_at: "2026-10-13T19:48:00Z", changes_today: 1, channels_today: ["Meta"],
  by_day: [880, 950, 980, 1000, 1040, 670].map((s, i) => ({ day: `2026-10-0${i + 1}`, bookings: 20, hosts: 10, spent_usd: s })),
};
const full = { kind: "CHANGE", headline: "Raised Meta budget: $150 → $300/day.", channels: ["Meta"], work: ["Compared two ads"], why: "Cheaper hosts", budget: [{ channel: "Meta", from_usd: 150, to_usd: 300 }], spent_usd: 640, bookings: 15, hosts: 18 };
const neutral = { kind: "WORK", headline: "Changed a Meta budget.", channels: ["Meta"], work: ["Compared two ads"], why: null, budget: [{ channel: "Meta", from_usd: null, to_usd: null }], spent_usd: null, bookings: null, hosts: null };
const row = (over: Partial<StoredDay> = {}): StoredDay => ({ day: "2026-10-03", status: "published", full_entry: full, neutral_entry: neutral, edited_headline: null, edited_why: null, edited_kind: null, ...over });
const LOCKED = new Date("2026-10-06T12:00:00Z"), OPEN = new Date("2026-10-13T20:00:00Z");

describe("toPublicPayload", () => {
  it("bookings, booking value and their pace are the push x the estimate factor; hosts and overrides are not", () => {
    const withValue = { ...snap, pace: { ...snap.pace, booking_value_per_week: 36000 }, by_day: snap.by_day.map((d) => ({ ...d, booking_value_usd: 5000 })) };
    const run = realRun({ goals: { booking_value_usd: 300000 }, bookings_estimate_factor: 1.35, overrides: { "2026-10-03": { bookings: 5 } } });
    const p = toPublicPayload({ snapshot: withValue, days: [], cfg: run, now: OPEN });
    expect(p.bookings_estimate_factor).toBe(1.35);
    expect(p.numbers).toMatchObject({ booking_value_usd: 6750 * 6, bookings: 27 * 5 + 5, hosts: 60, pace: { bookings_per_week: 161, hosts_per_week: 118, booking_value_per_week: 48600 } });
    expect(realRun().bookings_estimate_factor).toBe(1);
    expect(realRun({ bookings_estimate_factor: 50 }).bookings_estimate_factor).toBe(1);
    const raw = { tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", start_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 25000, goals: { booking_value_usd: 300000 } };
    expect(liveRunsRejection({ upcar: { ...raw, bookings_estimate_factor: 1.35 } })).toBeNull();
    expect(liveRunsRejection({ upcar: { ...raw, bookings_estimate_factor: 50 } })).toMatch(/bookings multiplier/);
  });
  it("unlocked before the first in-run snapshot: totals are unavailable, never 0", () => {
    const pre = { ...snap, by_day: [] };
    const n = toPublicPayload({ snapshot: pre, days: [], cfg, now: OPEN }).numbers!;
    expect([n.bookings, n.hosts, n.booking_value_usd]).toEqual([null, null, null]);
  });
  it("dollars booked: summed, goal passed through, one unavailable day makes the total null", () => {
    const withValue = { ...snap, pace: { ...snap.pace, booking_value_per_week: 36000 }, by_day: snap.by_day.map((d) => ({ ...d, booking_value_usd: 5000 })) };
    const run = { ...cfg, goals: { ...cfg.goals, booking_value_usd: 300000 } };
    const p = toPublicPayload({ snapshot: withValue, days: [], cfg: run, now: OPEN });
    expect(p.goals.booking_value_usd).toBe(300000);
    expect(p.numbers).toMatchObject({ booking_value_usd: 30000, pace: { booking_value_per_week: 36000 } });
    const gap = { ...withValue, by_day: withValue.by_day.map((d, i) => (i === 2 ? { ...d, booking_value_usd: null } : d)) };
    expect(toPublicPayload({ snapshot: gap, days: [], cfg: run, now: OPEN }).numbers!.booking_value_usd).toBeNull();
    const fixed = { ...run, overrides: { "2026-10-03": { booking_value_usd: 7000 } } };
    expect(toPublicPayload({ snapshot: gap, days: [], cfg: fixed, now: OPEN }).numbers!.booking_value_usd).toBe(32000);
    expect(toPublicPayload({ snapshot: withValue, days: [], cfg: run, now: LOCKED }).numbers).toBeNull();
  });
  it("locked: no numbers, neutral entries, edits ignored", () => {
    const p = toPublicPayload({ snapshot: snap, days: [row({ edited_headline: "Raised to $300", edited_kind: "WIN" })], cfg, now: LOCKED });
    expect(p.locked).toBe(true);
    expect(p.numbers).toBeNull();
    expect(p.days[0]).toMatchObject({ headline: "Changed a Meta budget.", kind: "WORK", why: null, spent_usd: null, budget: [{ from_usd: null, to_usd: null }] });
    expect(p.now_line.changes_today).toBe(1);
    expect(JSON.stringify(p)).not.toMatch(/\$[0-9]/);
  });
  it("unlocked: numbers filled from the snapshot", () => {
    const p = toPublicPayload({ snapshot: snap, days: [row()], cfg, now: OPEN });
    expect(p.numbers).toMatchObject({ spent_usd: 5520, spend_per_day_recent_usd: 970, bookings: 120, hosts: 60 });
    expect(p.numbers!.runs_out_day).toBe(13 + Math.ceil((25000 - 5520) / 970));
  });
  it("unlocked: Ravi's edits and tag win", () => {
    const p = toPublicPayload({ snapshot: snap, days: [row({ edited_headline: "My host ad works.", edited_kind: "WIN", edited_why: "Hosts at $28." })], cfg, now: OPEN });
    expect(p.days[0]).toMatchObject({ headline: "My host ad works.", kind: "WIN", why: "Hosts at $28." });
  });
  it("hand-set numbers win field by field, in totals and in the day's entry", () => {
    const fixed = { ...cfg, overrides: { "2026-10-03": { bookings: 5, spent_usd: 100 } } };
    const p = toPublicPayload({ snapshot: { ...snap, by_day: snap.by_day.map((d, i) => (i === 3 ? { ...d, hosts: null } : d)) }, days: [row()], cfg: { ...fixed, overrides: { ...fixed.overrides, "2026-10-04": { hosts: 7 } } }, now: OPEN });
    expect(p.numbers!.by_day[2]).toEqual({ day: "2026-10-03", bookings: 5, hosts: 10, spent_usd: 100, booking_value_usd: null });
    expect(p.numbers).toMatchObject({ bookings: 105, hosts: 57, spent_usd: 5520 - 980 + 100 });
    expect(p.days[0]).toMatchObject({ bookings: 5, hosts: 18, spent_usd: 100 });
  });
  it("a corrected day the stale snapshot has not reached still counts; days outside the run do not", () => {
    const stale = { ...snap, by_day: snap.by_day.slice(0, 5) };
    const p = toPublicPayload({ snapshot: stale, days: [], cfg: { ...cfg, overrides: { "2026-10-06": { bookings: 9, hosts: 4, spent_usd: 50 }, "2026-12-01": { bookings: 999 } } }, now: OPEN });
    expect(p.numbers!.by_day.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
    expect(p.numbers).toMatchObject({ bookings: 109, hosts: 54 });
  });
  it("drafts and hidden days never appear", () => {
    const p = toPublicPayload({ snapshot: snap, days: [row({ status: "draft" }), row({ status: "hidden", day: "2026-10-04" })], cfg, now: OPEN });
    expect(p.days).toEqual([]);
  });
  it("rebuilds from a whitelist and drops a day with an identifier", () => {
    const dirty = { ...full, targeting: { geo: "CA" }, object_id: "120214567890" };
    const p = toPublicPayload({ snapshot: snap, days: [row({ full_entry: dirty }), row({ day: "2026-10-04", full_entry: { ...full, work: ["act_123 raised"] } })], cfg, now: OPEN });
    expect(p.days).toHaveLength(1);
    expect(JSON.stringify(p)).not.toMatch(/targeting|object_id|act_/);
  });
  it("totals are null when any day is unavailable", () => {
    const s2 = { ...snap, by_day: snap.by_day.map((d, i) => (i === 2 ? { ...d, hosts: null } : d)) };
    const p = toPublicPayload({ snapshot: s2, days: [], cfg, now: OPEN });
    expect(p.numbers!.hosts).toBeNull();
    expect(p.numbers!.bookings).toBe(120);
  });
  it("carries a raised limit and when it moved", () => {
    const raise = { on: "2026-10-24", start_usd: 25000 };
    expect(toPublicPayload({ snapshot: snap, days: [], cfg: realRun({ budget_usd: 28400, budget_raise: raise }), now: OPEN })).toMatchObject({ budget_usd: 28400, budget_raise: raise });
    expect(toPublicPayload({ snapshot: snap, days: [], cfg, now: OPEN }).budget_raise).toBeNull();
  });
  it("names the run and whether it is listed", () => {
    expect(toPublicPayload({ snapshot: null, days: [], cfg: realRun({ home_pill: true }), now: OPEN }).run).toEqual({ slug: "upcar", listed: true });
    expect(toPublicPayload({ snapshot: null, days: [], cfg: realRun({}, "upcar-test"), now: OPEN }).run).toEqual({ slug: "upcar-test", listed: false });
  });
  it("a 3-day $500 test run unlocked from its start shows numbers on day 1", () => {
    const test = realRun({ start_at: "2026-09-28T09:00:00-04:00", unlock_at: undefined, end_at: "2026-09-30T23:59:59-04:00", budget_usd: 500, goals: { bookings: 40, hosts: 30 } }, "upcar-test");
    const s = { ...snap, day: 1, by_day: [{ day: "2026-09-28", bookings: 10, hosts: 8, spent_usd: 160 }] };
    const p = toPublicPayload({ snapshot: s, days: [], cfg: test, now: new Date("2026-09-28T20:00:00Z") });
    expect(p).toMatchObject({ locked: false, budget_usd: 500, goals: { bookings: 40, hosts: 30 }, numbers: { spent_usd: 160, bookings: 10, hosts: 8 } });
  });
  it("no snapshot yet: loading shape", () => {
    const p = toPublicPayload({ snapshot: null, days: [], cfg, now: OPEN });
    expect(p.numbers).toBeNull();
    expect(p.days).toEqual([]);
    expect(p.clock.unlock_at).toBe(cfg.unlock_at);
  });
  it("each published day carries when it was published and last changed (ISO), or null when unknown or bad", () => {
    const p = toPublicPayload({
      snapshot: snap,
      days: [
        row({ day: "2026-10-03", published_at: "2026-10-04 03:31:00+00", updated_at: "2026-10-04T03:31:00Z" }),
        row({ day: "2026-10-02", published_at: "not a date" }),
      ],
      cfg,
      now: OPEN,
    });
    expect(p.days.map((d) => [d.day, d.published_at, d.updated_at])).toEqual([
      ["2026-10-03", "2026-10-04T03:31:00.000Z", "2026-10-04T03:31:00.000Z"],
      ["2026-10-02", null, null],
    ]);
  });
});

describe("city names in published text", () => {
  it("are scrubbed on the way out, from the draft and from the owner's edit", () => {
    const why = "Your homepage lists Los Angeles cars from $39/day, and renter demand is the stated constraint.";
    const fromDraft = toPublicPayload({ snapshot: snap, days: [row({ full_entry: { ...full, why, work: ["Built a Miami search ad"] } })], cfg, now: OPEN });
    expect(fromDraft.days[0].why).toBe("Your homepage lists local cars from $39/day, and renter demand is the stated constraint.");
    expect(fromDraft.days[0].work).toEqual(["Built a local search ad"]);
    const fromEdit = toPublicPayload({ snapshot: snap, days: [row({ edited_why: why, edited_headline: "Opened search in Houston." })], cfg, now: OPEN });
    expect(fromEdit.days[0].why).not.toMatch(/Los Angeles/);
    expect(fromEdit.days[0].headline).toBe("Opened search in one city.");
  });
  it("stored task-brief headlines heal on read; one published untouched (prefilled) is cleaned too", () => {
    const brief = "Started Meta Ads: Read the live budget of 'a campaign' (an ad set) first, then propose raising it from $120 to $149 a day.";
    const e = { ...full, kind: "WORK", headline: brief, work: [brief], budget: [], channels: [] };
    const p = toPublicPayload({ snapshot: snap, days: [row({ day: "2026-10-11", full_entry: e, edited_headline: brief })], cfg, now: OPEN });
    expect(p.days[0].headline).toBe("Started work on Meta Ads.");
  });
  it("a stored day scrubbed by the old rules heals on read: no empty brackets, cities counted, quotes closed", () => {
    const work = [
      "Started Meta Ads: Resume the paused ad set 'a campaign' (, New Sales Campaign, Purchase on the Upcar Pixel, one city, one city, one city and one city) at $80/day.",
      "Started Google Ads: Raise a campaign () from $55/day to $110/day as an approval card.",
      "Started Meta Ads: Stage one new ad set in the a campaign campaign: optimized for Purchase on the Upcar Pixel (), lowest cost.",
      "Started TikTok Ads: Read only. Read 'a campaign: has it spent anything since Oct 17?",
      "Started TikTok Ads: Read 'a campaign, ad group ) live first. Use video.mp4 (artifact f928e[phone]c7-bed3-498ee970388d).",
      "Started content-design: Write two scripts. 1) A support reply (short).",
    ];
    const why = "For one city and one city, search the same dates next week.";
    const p = toPublicPayload({ snapshot: snap, days: [row({ full_entry: { ...full, work, why } })], cfg, now: OPEN });
    expect(p.days[0].work).toEqual([
      "Started Meta Ads: Resume the paused ad set 'a campaign' (New Sales Campaign, Purchase on the Upcar Pixel, four cities) at $80/day.",
      "Started Google Ads: Raise a campaign from $55/day to $110/day as an approval card.",
      "Started Meta Ads: Stage one new ad set in a campaign: optimized for Purchase on the Upcar Pixel, lowest cost.",
      "Started TikTok Ads: Read only. Read 'a campaign': has it spent anything since Oct 17?",
      "Started TikTok Ads: Read 'a campaign', ad group live first. Use video.mp4 (artifact).",
      "Started content-design: Write two scripts. 1) A support reply (short).",
    ]);
    expect(p.days[0].why).toBe("For two cities, search the same dates next week.");
  });
  it("the owner's own headline wins untouched, even when it repeats the day before", () => {
    const p = toPublicPayload({
      snapshot: snap, cfg, now: OPEN,
      days: [row({ day: "2026-10-02", edited_headline: "chatgpt day" }), row({ day: "2026-10-03", edited_headline: "chatgpt day" })],
    });
    expect(p.days.map((d) => d.headline)).toEqual(["chatgpt day", "chatgpt day"]);
  });
  it("a drafted count headline says the page's current figures, not the night's", () => {
    const e = { ...full, kind: "WORK", headline: "Spent $834 on ads and got 38 bookings that day.", work: [], budget: [], channels: [] };
    const p = toPublicPayload({ snapshot: snap, days: [row({ day: "2026-10-03", full_entry: e })], cfg, now: OPEN });
    expect(p.days[0].headline).toBe("Spent $980 on ads and got 20 bookings that day.");
    const own = toPublicPayload({ snapshot: snap, days: [row({ day: "2026-10-03", full_entry: e, edited_headline: "Spent $1 on ads that day." })], cfg, now: OPEN });
    expect(own.days[0].headline).toBe("Spent $1 on ads that day.");
  });
  it("no published day shows an earlier day's drafted headline; the fallback uses the page's figures", () => {
    const quiet = { ...full, kind: "WORK", headline: "Watched the numbers. Moved no money.", work: [], budget: [], channels: [], spent_usd: 833.78, bookings: 38 };
    const p = toPublicPayload({
      snapshot: snap, cfg, now: OPEN,
      days: [
        row({ day: "2026-10-01", full_entry: quiet }),
        row({ day: "2026-10-02", status: "hidden", full_entry: quiet }),
        row({ day: "2026-10-03", full_entry: quiet }),
        row({ day: "2026-10-04", full_entry: { ...quiet, spent_usd: null, bookings: null } }),
      ],
    });
    expect(p.days.map((d) => d.headline)).toEqual([
      "Spent $1,000 on ads and got 20 bookings that day.",
      "Spent $980 on ads and got 20 bookings that day.",
      "Watched the numbers. Moved no money.",
    ]);
  });
});
