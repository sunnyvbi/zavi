import { describe, expect, it, vi } from "vitest";
const facade = vi.hoisted(() => ({ tenantClient: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ tenantClient: facade.tenantClient, asTenantId: (id: string) => id }));
import { readLinkedInRefreshStatus, writeLinkedInRefreshStatus } from "../refresh-status";
const status = { page_url: "https://www.linkedin.com/company/example/", at: "2026-11-18T07:00:00Z", ok: false, message: "Could not read posts." };
function reader(value: unknown, error: unknown = null) {
  const q: any = { select: vi.fn(() => q), eq: vi.fn(() => q), maybeSingle: async () => ({data: {value}, error}) };
  return { q, sb: { from: vi.fn(() => q) } as any };
}
describe("LinkedIn refresh receipt", () => {
  it("uses the tenant-scoped server facade for service-only settings", async () => {
    const h = reader(status); facade.tenantClient.mockReturnValue(h.sb);
    expect(await readLinkedInRefreshStatus("tenant-test", status.page_url)).toEqual(status);
    expect(facade.tenantClient).toHaveBeenCalledWith("tenant-test");
  });
  it("reads only this tenant and the selected reference page", async () => {
    const h = reader(status);
    expect(await readLinkedInRefreshStatus("tenant-test", status.page_url, h.sb)).toEqual(status);
    expect(h.q.eq).toHaveBeenCalledWith("tenant_id", "tenant-test");
    expect(h.q.eq).toHaveBeenCalledWith("key", "linkedin_public_refresh");
    expect(await readLinkedInRefreshStatus("tenant-test", "https://www.linkedin.com/in/different/", h.sb)).toBeNull();
  });
  it.each([null, {}, {...status, at: "bad"}, {...status, ok: "false"}])("ignores malformed receipts", async value => {
    expect(await readLinkedInRefreshStatus("tenant-test", status.page_url, reader(value).sb)).toBeNull();
  });
  it("ignores failed reads and writes a tenant-scoped receipt", async () => {
    expect(await readLinkedInRefreshStatus("tenant-test", status.page_url, reader(status, {message: "unavailable"}).sb)).toBeNull();
    const upsert = vi.fn(async () => ({error: null}));
    await writeLinkedInRefreshStatus("tenant-test", status, {from: () => ({upsert})} as any);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({tenant_id:"tenant-test", key:"linkedin_public_refresh",value:status}), {onConflict:"tenant_id,key"});
  });
});
