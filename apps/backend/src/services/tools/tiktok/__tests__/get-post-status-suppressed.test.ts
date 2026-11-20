import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { publish_id: "p1" } }) }) }),
      update,
    }),
  }),
}));
vi.mock("@/services/connectors/tiktok/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchTikTokPostStatus: async () => ({ data: { status: "PUBLISH_COMPLETE" } }),
}));

import { tiktokGetPostStatusTool } from "../tools";

const POST = "11111111-1111-4111-8111-111111111111";
beforeEach(() => update.mockClear());

describe("tiktok_get_post_status", () => {
  it("writes-suppressed: returns the status, persists nothing", async () => {
    const r = await tiktokGetPostStatusTool.execute({ tenant_id: "t1", log: () => {}, writes_suppressed: true }, { post_id: POST });
    expect(r).toMatchObject({ data: { status: "PUBLISH_COMPLETE" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("normal run: persists the status as before", async () => {
    await tiktokGetPostStatusTool.execute({ tenant_id: "t1", log: () => {} }, { post_id: POST });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
