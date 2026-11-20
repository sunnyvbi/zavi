import { describe, it, expect, vi } from "vitest";

const resolvedError = { data: null, error: { message: "boom" } };

function builder(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const m of ["update", "select", "eq", "is", "lt", "maybeSingle"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(resolvedError).then(res);
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => builder() }),
  tenantRpc: async () => resolvedError,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));

import { DEFAULT_OUTAGE_DEPS } from "../direct/outage-card";

describe("outage card DB deps", () => {
  it("throw on a resolved Supabase error instead of reporting success", async () => {
    await expect(DEFAULT_OUTAGE_DEPS.claimOutage("t1")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.rollbackClaim("t1", "s")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.emitCard("t1", {})).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.storeCardId("t1", "d", "s")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.readOutage("t1")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.supersedeCard("t1", "d")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.releaseOutage("t1", "s")).rejects.toThrow("boom");
    await expect(DEFAULT_OUTAGE_DEPS.supersedeOpenCards("t1", "2026-10-21T00:00:00Z")).rejects.toThrow("boom");
  });
});
