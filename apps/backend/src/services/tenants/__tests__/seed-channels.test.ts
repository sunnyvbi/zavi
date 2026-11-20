
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) =>
    rpc(tid, name, args),
}));

import { seedTenantChannels } from "@/services/tenants/seed-channels";
import { CHANNELS } from "@zavi/shared";

const TID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => rpc.mockReset());

describe("seedTenantChannels", () => {
  it("seeds every channel in the registry, not a subset", async () => {
    rpc.mockResolvedValue({ data: CHANNELS.length, error: null });
    await seedTenantChannels(TID);

    const [, name, args] = rpc.mock.calls[0];
    expect(name).toBe("seed_tenant_channels");
    const slugs = (args as { p_slugs: string[] }).p_slugs;
    expect(slugs).toHaveLength(CHANNELS.length);
    expect(new Set(slugs)).toEqual(new Set(CHANNELS.map((c) => c.slug)));
  });

  it("routes through the tenant facade with the scoped tenant", async () => {
    rpc.mockResolvedValue({ data: 25, error: null });
    await seedTenantChannels(TID);
    expect(rpc.mock.calls[0][0]).toBe(TID);
  });

  it("never passes a tenant id in the RPC args — the facade injects it", async () => {
    rpc.mockResolvedValue({ data: 25, error: null });
    await seedTenantChannels(TID);
    expect(rpc.mock.calls[0][2]).not.toHaveProperty("p_tenant_id");
  });

  it("reports the inserted count", async () => {
    rpc.mockResolvedValue({ data: 25, error: null });
    expect(await seedTenantChannels(TID)).toEqual({
      channels_inserted: 25,
      error: null,
    });
  });

  it("surfaces an RPC error instead of silently reporting success", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await seedTenantChannels(TID)).toEqual({
      channels_inserted: 0,
      error: "boom",
    });
  });

  it("treats a non-numeric count as zero rather than NaN", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await seedTenantChannels(TID)).channels_inserted).toBe(0);
  });
});
