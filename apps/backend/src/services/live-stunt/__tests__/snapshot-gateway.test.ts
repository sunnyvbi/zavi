import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn(), close: vi.fn(async () => undefined) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.limit = async () => ({ data: [], error: null });
      return b;
    },
  }),
}));
vi.mock("@/services/tools/operator-db/resolve-attached", () => ({ resolveAttachedDb: h.resolve }));

import { realSnapshotDeps } from "../snapshot-deps";

describe("live run snapshot through the gateway", () => {
  it("counts bookings as a background read and closes the session", async () => {
    const driver = { query_new_bookings_in_range: vi.fn(async () => ({ ok: true, data: { available: true, count: 5 } })) };
    h.resolve.mockResolvedValue({ driver, cfg: {}, close: h.close });
    const deps = realSnapshotDeps({ tenant_id: "t1" } as never);
    expect(await deps.countBookings("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toBe(5);
    expect(h.resolve).toHaveBeenCalledWith({ tenant_id: "t1", caller: { kind: "background", feature: "Live run snapshot" } });
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});
