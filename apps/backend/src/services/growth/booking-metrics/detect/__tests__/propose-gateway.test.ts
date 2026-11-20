import { describe, it, expect, vi, beforeEach } from "vitest";
import { gatewayHarness } from "@/services/data-gateway/__tests__/harness";

const h = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof import("@/services/data-gateway/__tests__/harness").gatewayHarness>,
  reserve: vi.fn(),
  rpc: vi.fn(),
  detect: vi.fn(),
}));
vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: h.reserve,
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withReadSession: (ctx: never, fn: never) => h.current!.withReadSession(ctx, fn),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: h.rpc }) }));
vi.mock("../detect", () => ({ detectBookingMapping: h.detect }));
vi.mock("../verify", () => ({ verifyMapping: (d: Record<string, unknown>) => ({ ...d, blockers: [], warnings: [], amount_unit: "dollars" }) }));
vi.mock("../../config", () => ({ getBookingMetricConfig: async () => null }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { detectAndProposeBookingMapping } from "../propose";

beforeEach(() => {
  h.reserve.mockReset().mockResolvedValue("log-1");
  h.rpc.mockReset().mockResolvedValue({ error: null });
  h.detect.mockReset().mockResolvedValue({ booking_source: "bookings", date_field: "created_at", status_field: null, completed_statuses: [], revenue_field: "total", refund_field: null, currency: "USD" });
});

describe("booking setup check through the gateway", () => {
  it("auto-hidden users still yields a proposal from visible columns; samples never name a hidden column", async () => {
    const catalog = {
      tables: [
        { name: "users", columns: [{ name: "id", type: "int" }, { name: "email", type: "text" }] },
        { name: "bookings", columns: [{ name: "id", type: "int" }, { name: "created_at", type: "timestamptz" }, { name: "total", type: "numeric" }, { name: "guest_phone", type: "text" }] },
      ],
    };
    h.current = gatewayHarness({
      dialect: "postgres",
      catalog,
      hidden: ["users.email", "bookings.guest_phone"],
      rows: [{ id: 1, created_at: new Date("2026-10-01T00:00:00Z"), total: "12.50" }],
    });
    const r = await detectAndProposeBookingMapping("t1");
    expect(r?.mapping.booking_source).toBe("bookings");
    const sqls = h.current.fake.calls.sql.map((c) => c.text);
    expect(sqls.length).toBeGreaterThan(0);
    for (const q of sqls) {
      expect(q).not.toMatch(/email|guest_phone|pg_class|information_schema/);
    }
    expect(h.reserve.mock.calls[0]![0]).toMatchObject({ ctx: { caller: { kind: "background", feature: "Booking setup check" } } });
    expect(JSON.stringify(h.detect.mock.calls[0]![0])).not.toMatch(/email|guest_phone/);
  });
});
