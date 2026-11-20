import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ connected: vi.fn(), stats: vi.fn(), videos: vi.fn(), rpc: vi.fn(), upsert: vi.fn() }));
vi.mock("@/services/connectors/tiktok/api", () => ({ isTikTokConnected: m.connected, queryAccountStats: m.stats, queryVideoList: m.videos }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (x: string) => x, tenantRpc: m.rpc,
  tenantClient: () => ({ from: (table: string) => ({ upsert: (rows: unknown) => m.upsert(table, rows) }) }),
}));
import { refreshTikTok } from "../snapshots";
beforeEach(() => {
  vi.clearAllMocks(); m.connected.mockResolvedValue(true); m.rpc.mockResolvedValue({ data: 1, error: null });
  m.stats.mockResolvedValue({ display_name: "Creator", video_count: 0 });
  m.upsert.mockResolvedValue({ error: null }); m.videos.mockResolvedValue({ data: { videos: [] } });
});
describe("TikTok refresh integrity", () => {
  it.each([{}, { data: {} }, { data: { videos: {} } }, { data: { videos: [null] } }, { data: { videos: [{}] } }])("does not cache a malformed video success: %j", async videos => {
    m.videos.mockResolvedValue(videos);
    expect(await refreshTikTok("tenant-a")).toMatchObject({ ok: false, reason: "read_failed" });
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it("does not mark today complete if post persistence fails", async () => {
    m.videos.mockResolvedValue({ data: { videos: [{ id: "v1" }] } });
    m.upsert.mockImplementation(async (table: string) => ({ error: table === "social_post_metric_snapshots" ? { message: "write failed" } : null }));
    expect(await refreshTikTok("tenant-a")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(m.upsert.mock.calls.map(c => c[0])).toEqual(["social_post_metric_snapshots"]);
  });
  it("stores a valid account with no videos", async () => {
    expect(await refreshTikTok("tenant-a")).toMatchObject({ ok: true, posts: 0 });
    expect(m.upsert).toHaveBeenCalledWith("social_account_snapshots", expect.objectContaining({ tenant_id: "tenant-a", post_count: 0 }));
  });
});
