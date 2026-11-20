import { describe, it, expect, vi, beforeEach } from "vitest";
import { gatewayHarness } from "@/services/data-gateway/__tests__/harness";

const h = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/services/data-gateway/__tests__/harness").gatewayHarness>, reserve: vi.fn() }));
vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: h.reserve,
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withReadSession: (ctx: never, fn: never) => h.current!.withReadSession(ctx, fn),
}));

import { fetchOperatorBookingsDaily } from "../daily";
import type { BookingMetricConfig } from "../config";

const cfg = (over: Partial<BookingMetricConfig> = {}): BookingMetricConfig =>
  ({
    engine: "postgres",
    booking_source: "bookings",
    date_field: "created_at",
    status_field: "status",
    completed_statuses: ["done"],
    revenue_field: "total",
    refund_field: null,
    refund_basis: "none",
    amount_unit: "dollars",
    currency: "USD",
    reporting_timezone: "America/Chicago",
    ...over,
  }) as BookingMetricConfig;
const catalog = {
  tables: [
    { name: "bookings", columns: [{ name: "id" }, { name: "created_at" }, { name: "status" }, { name: "total" }, { name: "guest_email" }] },
    { name: "users", columns: [{ name: "_id" }, { name: "email" }] },
  ],
};

beforeEach(() => {
  h.reserve.mockReset().mockResolvedValue("log-1");
});

describe("booking metrics read through the gateway", () => {
  it("Postgres: background caller 'Booking metrics', query passes the guard, hidden column never returned", async () => {
    h.current = gatewayHarness({ dialect: "postgres", catalog, hidden: ["bookings.guest_email"], rows: [{ day: "2026-10-01", bookings: 3, revenue: 90, guest_email: "a@b.c" }] });
    const out = await fetchOperatorBookingsDaily("t1", cfg(), { sinceIso: "2026-10-01", untilIso: "2026-10-02" });
    expect(out?.rows).toEqual([{ date: "2026-10-01", bookings: 3, revenue_native: 90 }]);
    expect(h.current.contexts[0]).toEqual({ tenant_id: "t1", caller: { kind: "background", feature: "Booking metrics" } });
    expect(h.reserve.mock.calls[0]![0]).toMatchObject({ ctx: { caller: { kind: "background", feature: "Booking metrics" } }, tables: ["bookings"] });
    expect(h.current.fake.calls.sql[0]!.text).toContain('(SELECT "id", "created_at", "status", "total" FROM ONLY "public"."bookings") AS "bookings"');
  });
  it("Mongo: the aggregate gets the $unset for the hidden field", async () => {
    h.current = gatewayHarness({ dialect: "mongodb", catalog, hidden: ["bookings.guest_email"], docs: [{ _id: "2026-10-01", bookings: 2 }] });
    const out = await fetchOperatorBookingsDaily("t1", cfg({ engine: "mongodb" }), { sinceIso: "2026-10-01", untilIso: "2026-10-02" });
    expect(out?.rows[0]).toMatchObject({ date: "2026-10-01", bookings: 2 });
    const pipeline = h.current.fake.calls.mongo[0]!.args[1] as unknown[];
    expect(pipeline[0]).toEqual({ $unset: ["guest_email"] });
  });
  it("a refused read (switched-off table) skips the rollup instead of throwing", async () => {
    h.current = gatewayHarness({ dialect: "postgres", catalog, disabled: ["bookings"] });
    expect(await fetchOperatorBookingsDaily("t1", cfg(), { sinceIso: "2026-10-01", untilIso: "2026-10-02" })).toBeNull();
    expect(h.current.fake.calls.sql).toHaveLength(0);
  });
});
