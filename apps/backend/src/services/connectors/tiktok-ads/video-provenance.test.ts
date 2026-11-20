import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ tenant: vi.fn(), filters: [] as unknown[][], data: [] as { source_key: string }[], error: null as null | { message: string } }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: (id: string) => {
    m.tenant(id);
    const query = {
      select: (columns: string) => { m.filters.push(["select", columns]); return query; },
      eq: (key: string, value: string) => { m.filters.push(["eq", key, value]); return query; },
      like: (key: string, value: string) => { m.filters.push(["like", key, value]); return query; },
      limit: async (limit: number) => { m.filters.push(["limit", limit]); return { data: m.data, error: m.error }; },
    };
    return { from: (table: string) => { m.filters.push(["from", table]); return query; } };
  },
}));
import { isKnownGeneratedVideo } from "./video-provenance";
beforeEach(() => { vi.clearAllMocks(); m.filters = []; m.data = []; m.error = null; });
it("checks only the current tenant, advertiser, selected video and generated source prefix", async () => {
  m.data = [{ source_key: "zavi:artifact" }];
  expect(await isKnownGeneratedVideo("tenant-a", "111", "video2")).toBe(true);
  expect(m.tenant).toHaveBeenCalledWith("tenant-a");
  expect(m.filters).toEqual([["from", "tiktok_ad_video_uploads"], ["select", "source_key"], ["eq", "advertiser_id", "111"], ["eq", "video_id", "video2"], ["like", "source_key", "zavi:%"], ["limit", 1]]);
});
it("does not treat a missing record or uploaded file as known generated content", async () => {
  expect(await isKnownGeneratedVideo("tenant-a", "111", "video2")).toBe(false);
  m.data = [{ source_key: "upload:tenant-a/file.mp4" }];
  expect(await isKnownGeneratedVideo("tenant-a", "111", "video2")).toBe(false);
});
it("does not mistake a database failure for unknown provenance", async () => {
  m.error = { message: "unavailable" };
  await expect(isKnownGeneratedVideo("tenant-a", "111", "video2")).rejects.toMatchObject({ code: "tiktok_ads_video_provenance_unreadable" });
});
