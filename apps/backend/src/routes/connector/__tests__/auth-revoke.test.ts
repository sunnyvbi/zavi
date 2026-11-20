import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { resolveConnectorToken } from "../auth";
import { _setWakeupDepsForTests, publishRevoke } from "@/services/data-gateway/connector/wakeup";

const GOOD = "zconn_" + "a".repeat(64);

describe("token cache + revocation", () => {
  it("publishRevoke(tenant) drops that tenant's cached token, so the next request re-checks the database", async () => {
    _setWakeupDepsForTests({
      client: () => ({ channel: () => ({ on() { return this; }, subscribe() { return this; }, httpSend: async () => ({ success: true }) }) }) as never,
      log: async () => undefined,
    });
    const pre = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ tenant_id: "tenant-A", connector_id: "conn-A" }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const d = { preTenantRpc: pre as never };
    expect(await resolveConnectorToken(GOOD, d)).toEqual({ tenant_id: "tenant-A", connector_id: "conn-A" });
    await publishRevoke("tenant-A");
    expect(await resolveConnectorToken(GOOD, d)).toBe("unknown");
    expect(pre).toHaveBeenCalledTimes(2);
  });
});
