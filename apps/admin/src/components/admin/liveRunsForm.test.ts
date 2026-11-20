import { describe, it, expect } from "vitest";
import { etLocalToIso, isoToEtLocal, rowsFromBlob, blobFromRows, newRow, UPCAR_AI_TENANT } from "./liveRunsForm";

describe("live runs form helpers", () => {
  it("a dollar correction survives a save", () => {
    const blob = { live_runs: { upcar: { tenant_id: "t", start_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 25000, goals: { booking_value_usd: 300000 }, overrides: { "2026-10-03": { booking_value_usd: 7000 } } } } };
    expect((blobFromRows(rowsFromBlob(blob)).upcar as { overrides: unknown }).overrides).toEqual({ "2026-10-03": { booking_value_usd: 7000 } });
  });
  it("a budget raise survives a save, and clearing both boxes removes it", () => {
    const run = { tenant_id: "t", start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 28400, budget_raise: { on: "2026-10-24", start_usd: 25000 }, goals: { booking_value_usd: 300000 }, public: true, home_pill: true };
    const rows = rowsFromBlob({ live_runs: { upcar: run } });
    expect(rows[0]).toMatchObject({ raise_start_usd: "25000", raise_on: "2026-10-24" });
    expect((blobFromRows(rows).upcar as { budget_raise: unknown }).budget_raise).toEqual(run.budget_raise);
    expect(blobFromRows([{ ...rows[0], raise_start_usd: "", raise_on: "" }]).upcar).not.toHaveProperty("budget_raise");
  });
  it("one box left empty goes to the backend as is, so the save is refused, not dropped", () => {
    const rows = rowsFromBlob({ live_runs: { upcar: { tenant_id: "t", start_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 28400, goals: { hosts: 1, bookings: 1 } } } });
    expect((blobFromRows([{ ...rows[0], raise_on: "2026-10-24" }]).upcar as { budget_raise: unknown }).budget_raise).toEqual({ on: "2026-10-24", start_usd: 0 });
  });
  it("converts Eastern wall time with the right offset (EDT in Sep/Oct, EST in Dec)", () => {
    expect(etLocalToIso("2026-09-28T09:00")).toBe("2026-09-28T09:00:00-04:00");
    expect(etLocalToIso("2026-12-01T09:00")).toBe("2026-12-01T09:00:00-05:00");
    expect(etLocalToIso("")).toBeNull();
  });
  it("round-trips a run", () => {
    const blob = { live_runs: { "upcar-test": { tenant_id: "t", start_at: "2026-09-28T09:00:00-04:00", unlock_at: "2026-09-28T09:00:00-04:00", end_at: "2026-09-30T23:59:00-04:00", budget_usd: 500, goals: { bookings: 40, hosts: 30 }, public: true, home_pill: false } } };
    const rows = rowsFromBlob(blob);
    expect(rows[0]).toMatchObject({ slug: "upcar-test", start: "2026-09-28T09:00", unlock: "", end: "2026-09-30T23:59", budget_usd: "500", public: true });
    expect(blobFromRows(rows)).toEqual(blob.live_runs);
  });
  it("round-trips an optional dollar goal; blank leaves it out", () => {
    const blob = { live_runs: { upcar: { tenant_id: "t", start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 25000, goals: { bookings: 600, hosts: 500, booking_value_usd: 300000 }, public: true, home_pill: true } } };
    const rows = rowsFromBlob(blob);
    expect(rows[0].goal_value_usd).toBe("300000");
    expect((blobFromRows(rows).upcar as { goals: unknown }).goals).toEqual({ bookings: 600, hosts: 500, booking_value_usd: 300000 });
    expect((blobFromRows([{ ...rows[0], goal_value_usd: "" }]).upcar as { goals: unknown }).goals).toEqual({ bookings: 600, hosts: 500 });
  });
  it("a new run defaults to the upcar-ai tenant, private, no pill", () => {
    expect(newRow("upcar-test")).toMatchObject({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", public: false, home_pill: false });
    expect(isoToEtLocal(undefined)).toBe("");
  });
});

describe("number corrections", () => {
  it("round-trips per-day fixes, keeps unedited fields, and clearing a fix removes it", () => {
    const blob = { live_runs: { "upcar-test": { tenant_id: UPCAR_AI_TENANT, start_at: "2026-09-28T09:00:00-04:00", unlock_at: "2026-09-28T09:00:00-04:00", end_at: "2026-09-30T23:59:00-04:00", budget_usd: 500, goals: { bookings: 60, hosts: 50 }, public: true, home_pill: false, host_match: { hostStatus: true }, overrides: { "2026-09-29": { bookings: 12, spent_usd: 80.5 } } } } };
    const rows = rowsFromBlob(blob);
    expect(rows[0].fixes).toEqual([{ day: "2026-09-29", bookings: "12", hosts: "", spent_usd: "80.5", booking_value_usd: "" }]);
    expect(blobFromRows(rows)).toEqual(blob.live_runs);
    const cleared = blobFromRows([{ ...rows[0], fixes: [] }])["upcar-test"] as Record<string, unknown>;
    expect(cleared.overrides).toBeUndefined();
    expect(cleared.host_match).toEqual({ hostStatus: true });
    const dup = blobFromRows([{ ...rows[0], fixes: [{ day: "2026-09-29", bookings: "12", hosts: "", spent_usd: "", booking_value_usd: "" }, { day: "2026-09-29", bookings: "", hosts: "5", spent_usd: "", booking_value_usd: "" }] }])["upcar-test"] as Record<string, unknown>;
    expect(dup.overrides).toEqual({ "2026-09-29": { bookings: 12, hosts: 5 } });
  });

  it("bookings multiplier: blank or 1 stores nothing, any other value round-trips", () => {
    const blob = { live_runs: { upcar: { tenant_id: UPCAR_AI_TENANT, start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00", budget_usd: 25000, goals: { booking_value_usd: 300000 }, public: true, home_pill: true, bookings_estimate_factor: 1.35 } } };
    const rows = rowsFromBlob(blob);
    expect(rows[0].bookings_factor).toBe("1.35");
    expect(blobFromRows(rows)).toEqual(blob.live_runs);
    const off = blobFromRows([{ ...rows[0], bookings_factor: "" }]).upcar as Record<string, unknown>;
    expect(off.bookings_estimate_factor).toBeUndefined();
  });
});
