import { describe, it, expect } from "vitest";
import { parseLiveRun, parseLiveRuns, liveRunsRejection } from "../config";
import { liveRunStartMoveRejection } from "../config";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const TEST = { tenant_id: T, start_at: "2026-09-28T09:00:00-04:00", end_at: "2026-09-30T23:59:59-04:00", budget_usd: 500, goals: { bookings: 40, hosts: 30 }, public: true };

describe("live runs config", () => {
  it("a dollar goal alone is enough; count goals then optional, and without it both counts are required", () => {
    const c = parseLiveRun("upcar", { ...TEST, goals: { booking_value_usd: 300000 } })!;
    expect(c.goals).toEqual({ bookings: null, hosts: null, booking_value_usd: 300000 });
    expect(parseLiveRun("upcar", { ...TEST, goals: { bookings: 40 } })).toBeNull();
  });
  it("an optional dollar goal is kept; a bad one is dropped, not fatal", () => {
    expect(parseLiveRun("upcar", { ...TEST, goals: { bookings: 40, hosts: 30, booking_value_usd: 300000 } })!.goals).toEqual({ bookings: 40, hosts: 30, booking_value_usd: 300000 });
    expect(parseLiveRun("upcar", { ...TEST, goals: { bookings: 40, hosts: 30, booking_value_usd: -1 } })!.goals).toEqual({ bookings: 40, hosts: 30 });
  });
  it("parses a 3-day $500 test run; unlock defaults to the start", () => {
    const c = parseLiveRun("upcar-test", TEST)!;
    expect(c).toMatchObject({ slug: "upcar-test", budget_usd: 500, goals: { bookings: 40, hosts: 30 }, unlock_at: TEST.start_at, public: true, home_pill: false, host_match: { hostStatus: true } });
  });
  it("keeps good runs when another is broken", () => {
    const runs = parseLiveRuns({ live_runs: { "upcar-test": TEST, upcar: { tenant_id: T } } });
    expect(runs.map((r) => r.slug)).toEqual(["upcar-test"]);
  });
  it("requires tenant, dates, budget and goals (no silent $25,000 default)", () => {
    for (const k of ["tenant_id", "start_at", "end_at", "budget_usd", "goals"]) {
      const raw: Record<string, unknown> = { ...TEST };
      delete raw[k];
      expect(parseLiveRun("upcar-test", raw), k).toBeNull();
    }
  });
  it("rejects bad slugs, out-of-order dates and absurd lengths", () => {
    expect(parseLiveRun("Upcar Test", TEST)).toBeNull();
    expect(parseLiveRun("upcar-test", { ...TEST, unlock_at: "2026-09-01T00:00:00Z" })).toBeNull();
    expect(parseLiveRun("upcar-test", { ...TEST, end_at: "2027-09-01T00:00:00Z" })).toBeNull();
  });
  it("a run must start on the hour (counts arrive in hourly buckets)", () => {
    expect(parseLiveRun("upcar-test", { ...TEST, start_at: "2026-09-28T09:30:00-04:00" })).toBeNull();
    expect(liveRunsRejection({ "upcar-test": { ...TEST, start_at: "2026-09-28T09:30:00-04:00" } })).toMatch(/on the hour/);
  });
  it("host match is equality-only", () => {
    expect(parseLiveRun("upcar-test", { ...TEST, host_match: { hostStatus: { $ne: false } } })!.host_match).toEqual({ hostStatus: true });
  });
  it("public and home_pill default off", () => {
    const { public: _p, ...priv } = TEST;
    expect(parseLiveRun("x", priv)).toMatchObject({ public: false, home_pill: false });
  });
});

describe("liveRunsRejection (admin save guard)", () => {
  it("accepts good runs, names a bad one, allows one home pill", () => {
    expect(liveRunsRejection({ "upcar-test": TEST })).toBeNull();
    expect(liveRunsRejection({ "upcar-test": TEST, upcar: { tenant_id: T } })).toMatch(/Run "upcar"/);
    expect(liveRunsRejection({ a: { ...TEST, home_pill: true }, b: { ...TEST, home_pill: true } })).toMatch(/Only one run/);
    expect(liveRunsRejection([])).toMatch(/object keyed by page slug/);
  });
});

describe("budget_raise", () => {
  const raise = { on: "2026-09-29", start_usd: 400 };
  it("parses, and is null when never raised", () => {
    expect(parseLiveRun("upcar-test", { ...TEST, budget_raise: raise })?.budget_raise).toEqual(raise);
    expect(parseLiveRun("upcar-test", TEST)?.budget_raise).toBeNull();
  });
  it("a bad one is refused on save, and a stored one is ignored so the page still shows", () => {
    expect(liveRunsRejection({ "upcar-test": { ...TEST, budget_raise: raise } })).toBeNull();
    for (const bad of [{ on: "24 Oct", start_usd: 400 }, { on: "2026-02-30", start_usd: 400 }, { on: "2026-09-29" }, { on: "", start_usd: 400 }, { on: "2026-09-29", start_usd: 0 }, "soon"]) {
      expect(liveRunsRejection({ "upcar-test": { ...TEST, budget_raise: bad } })).toMatch(/budget raise/);
      expect(parseLiveRun("upcar-test", { ...TEST, budget_raise: bad })?.budget_raise).toBeNull();
    }
  });
});

describe("overrides (hand-set numbers)", () => {
  it("parses per-day corrections and refuses malformed ones on save", () => {
    const run = parseLiveRun("upcar-test", { ...TEST, overrides: { "2026-09-29": { bookings: 12, hosts: null, spent_usd: 101.234 } } });
    expect(run?.overrides).toEqual({ "2026-09-29": { bookings: 12, spent_usd: 101.23 } });
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-09-29": { bookings: 12 } } } })).toBeNull();
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "29 Sep": { bookings: 1 } } } })).toMatch(/number correction/);
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-02-29": { bookings: 1 } } } })).toMatch(/number correction/);
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-13-45": { bookings: 1 } } } })).toMatch(/number correction/);
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-09-29": { bookings: -1 } } } })).toMatch(/number correction/);
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-09-29": { bookings: 1.5 } } } })).toMatch(/number correction/);
    expect(liveRunsRejection({ "upcar-test": { ...TEST, overrides: { "2026-09-29": { visits: 3 } } } })).toMatch(/number correction/);
  });
});

describe("liveRunStartMoveRejection", () => {
  const current = [
    { slug: "upcar", start_at: "2026-10-01T00:00:00-04:00", public: true, home_pill: true },
    { slug: "upcar-test", start_at: "2026-09-28T09:00:00-04:00", public: true, home_pill: false },
    { slug: "later", start_at: "2026-11-01T00:00:00-04:00", public: true, home_pill: false },
  ];
  const now = new Date("2026-10-12T12:00:00Z");
  it("refuses to move the start of a run that has started (its day URLs are numbered from it)", () => {
    expect(liveRunStartMoveRejection({ upcar: { start_at: "2026-10-02T00:00:00-04:00" } }, current, now)).toMatch(/upcar.*has started/);
  });
  it("refuses to remove the started featured run (re-adding the slug would renumber it), but a test run can go", () => {
    expect(liveRunStartMoveRejection({ "upcar-test": {} }, current, now)).toMatch(/upcar.*cannot be removed/);
    expect(liveRunStartMoveRejection({ upcar: { budget_usd: 1 } }, current, now)).toBeNull();
  });
  it("allows the same instant written another way, other edits, a run not started yet, and a new run", () => {
    expect(liveRunStartMoveRejection({ upcar: { start_at: "2026-10-01T04:00:00Z", budget_usd: 30000 } }, current, now)).toBeNull();
    expect(liveRunStartMoveRejection({ upcar: { budget_usd: 30000 } }, current, now)).toBeNull();
    expect(liveRunStartMoveRejection({ upcar: {}, later: { start_at: "2026-11-02T00:00:00-04:00" } }, current, now)).toBeNull();
    expect(liveRunStartMoveRejection({ upcar: {}, fresh: { start_at: "2026-10-20T00:00:00-04:00" } }, current, now)).toBeNull();
  });
});
