import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn(), resolve: vi.fn(), proxy: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: m.rpc,
}));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.resolve }));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: m.proxy }));
import { refreshInstagram } from "../snapshots";

beforeEach(() => {
  vi.useRealTimers();
  m.resolve.mockReset().mockResolvedValue({ connected_account_id: "ca_new" });
  m.rpc.mockReset().mockImplementation(async (_t, name) => ({ data: name === "consume_metered_read_or_reject" ? 1 : true, error: null }));
  m.proxy.mockReset().mockImplementation(async ({ endpoint }) => {
    const path = new URL(endpoint).pathname;
    if (path.endsWith("/me")) return { ok: true, status: 200, json: { user_id: "17841", username: "owner", followers_count: 0, media_count: 1 } };
    if (path.endsWith("/media")) return { ok: true, status: 200, json: { data: [{ id: "post1", caption: "hello", timestamp: "2026-09-30T13:22:38+0000" }] } };
    return { ok: true, status: 200, json: { data: [{ name: "views", values: [{ value: 2 }] }] } };
  });
});

describe("refreshInstagram", () => {
  it("stores a complete read atomically with its stable account and original connection", async () => {
    expect(await refreshInstagram("t")).toMatchObject({ ok: true, posts: 1, used: 1 });
    expect(m.rpc).toHaveBeenLastCalledWith("t", "store_instagram_snapshots", expect.objectContaining({
      p_connection_id: "ca_new", p_account_id: "17841",
      p_captured_at: expect.any(String),
      p_account: expect.objectContaining({ username: "owner", post_count: 1 }),
      p_posts: [expect.objectContaining({ external_post_id: "post1", metrics: { views: 2, likes: null, comments: null } })],
    }));
  });

  it("records the read start, even if it crosses UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T23:59:59Z"));
    m.resolve.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-20T00:00:05Z"));
      return { connected_account_id: "ca_new" };
    });
    await refreshInstagram("t");
    expect(m.rpc.mock.calls[1][2].p_captured_at).toBe("2026-10-19T23:59:59.000Z");
    expect(m.rpc.mock.calls[0][2].p_day).toBe("2026-10-19");
  });

  it.each([{}, { data: null }, { data: [null] }, { data: [{}] }])("does not replace the cache with malformed media (%j)", async (json) => {
    m.proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { user_id: "17841" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json });
    expect(await refreshInstagram("t")).toMatchObject({ ok: false, reason: "read_failed" });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected obsolete write instead of claiming the refresh succeeded", async () => {
    m.rpc.mockImplementation(async (_t, name) => ({ data: name === "consume_metered_read_or_reject" ? 1 : false, error: null }));
    expect(await refreshInstagram("t")).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("keeps storage errors visible", async () => {
    m.rpc.mockImplementation(async (_t, name) => name === "consume_metered_read_or_reject"
      ? { data: 1, error: null } : { data: null, error: { message: "write failed" } });
    expect(await refreshInstagram("t")).toMatchObject({ ok: false, message: expect.stringContaining("write failed") });
  });

  it("does not spend a read without a connection", async () => {
    m.resolve.mockResolvedValue(null);
    expect(await refreshInstagram("t")).toMatchObject({ ok: false, reason: "not_connected" });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.proxy).not.toHaveBeenCalled();
  });

  it("does not call Graph after the cap is reached", async () => {
    m.rpc.mockResolvedValue({ data: null, error: null });
    expect(await refreshInstagram("t")).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(m.proxy).not.toHaveBeenCalled();
  });
});
