import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Record<string, number>[], calls: [] as unknown[][] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (...a: unknown[]) => { h.calls.push(["eq", ...a]); return b; };
      b.gte = (...a: unknown[]) => { h.calls.push(["gte", ...a]); return b; };
      b.lt = (...a: unknown[]) => { h.calls.push(["lt", ...a]); return Promise.resolve({ data: h.rows, error: null }); };
      return b;
    },
  }),
}));
vi.mock("@/services/tools/operator-db/resolve-attached", () => ({ resolveAttachedDb: vi.fn() }));

import { pushedCount } from "../snapshot-deps";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const NOW = new Date("2026-09-28T14:30:00Z");
const push = { covered_from: "2026-08-24T14:00:00Z", covered_to: "2026-09-28T15:00:00Z", metrics: ["bookings", "new_hosts"], pushed_at: "2026-09-28T14:20:00Z" };

beforeEach(() => { h.rows = []; h.calls = []; });

describe("pushedCount", () => {
  it("sums the pushed hours in [since, until); missing hours are real zeros", async () => {
    h.rows = [{ value: 3 }, { value: 4 }];
    expect(await pushedCount(T, "bookings", "2026-09-28T13:00:00Z", "2026-09-28T14:30:00Z", NOW, push)).toBe(7);
    expect(h.calls).toContainEqual(["eq", "metric", "bookings"]);
    h.rows = [];
    expect(await pushedCount(T, "bookings", "2026-09-28T13:00:00Z", "2026-09-28T14:30:00Z", NOW, push)).toBe(0);
  });
  it("null (unavailable, never 0) with no push, a stale push, or a range outside coverage", async () => {
    expect(await pushedCount(T, "bookings", "2026-09-28T13:00:00Z", "2026-09-28T14:00:00Z", NOW, null)).toBeNull();
    expect(await pushedCount(T, "new_hosts", "2026-09-28T13:00:00Z", "2026-09-28T14:00:00Z", NOW, { ...push, metrics: ["bookings"] })).toBeNull();
    expect(await pushedCount(T, "bookings", "2026-09-28T13:00:00Z", "2026-09-28T14:00:00Z", NOW, { ...push, pushed_at: "2026-09-28T11:00:00Z" })).toBeNull();
    expect(await pushedCount(T, "bookings", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z", NOW, push)).toBeNull();
    expect(await pushedCount(T, "new_hosts", "2026-09-28T13:00:00Z", "2026-09-29T00:00:00Z", NOW, push)).toBeNull();
  });
});
