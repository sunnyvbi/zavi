
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), upsert: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => ({ upsert: m.upsert }) }),
}));

import { channelCheckDone } from "../checks";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
function res() {
  const r = { status: vi.fn(), json: vi.fn() } as unknown as { status: (n: number) => unknown; json: (b: unknown) => unknown; _status?: number; _body?: unknown };
  (r.status as unknown as ReturnType<typeof vi.fn>).mockImplementation((n: number) => { r._status = n; return r; });
  (r.json as unknown as ReturnType<typeof vi.fn>).mockImplementation((b: unknown) => { r._body = b; return r; });
  return r;
}

beforeEach(() => {
  m.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "u" });
  m.upsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/channels/x_organic/checks/:key/done", () => {
  it("records the dismissal for the caller's tenant", async () => {
    const r = res();
    await channelCheckDone({ params: { slug: "x_organic", key: "bio" }, body: { tenant_id: "someone-else" } } as never, r as never);
    expect(r._body).toEqual({ ok: true, key: "bio" });
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, channel: "x", check_key: "bio" }),
      { onConflict: "tenant_id,channel,check_key" },
    );
  });

  it("refuses a key that is not one of the four checks, and any other channel", async () => {
    for (const params of [{ slug: "x_organic", key: "delete_everything" }, { slug: "reddit_organic", key: "bio" }]) {
      const r = res();
      await channelCheckDone({ params } as never, r as never);
      expect(r._status).toBe(400);
    }
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("does nothing without auth", async () => {
    m.requireAuth.mockResolvedValue(null);
    await channelCheckDone({ params: { slug: "x_organic", key: "bio" } } as never, res() as never);
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
