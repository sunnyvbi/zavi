import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  readLiveEditState: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t1", user_id: "u1" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: vi.fn(async () => true) }));
vi.mock("@/services/build/live-edit", () => ({
  LiveEditError: class LiveEditError extends Error {},
  discardDraft: vi.fn(),
  publishDraft: vi.fn(),
  wakeLiveEditPreview: vi.fn(),
  readLiveEditState: mocks.readLiveEditState,
}));

import { getLiveEditState } from "@/routes/workspace/live-edit";

function res() {
  const r = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  return Object.assign(r, {
    set(k: string, v: string) { r.headers[k] = v; return this; },
    status(c: number) { r.statusCode = c; return this; },
    json(b: unknown) { r.body = b; return this; },
  });
}

describe("GET live-edit state keeps the sandbox awake only for a framed preview", () => {
  beforeEach(() => {
    mocks.readLiveEditState.mockReset().mockResolvedValue({ enabled: true });
  });

  it("passes framed:true only when the web says the preview is framed", async () => {
    await getLiveEditState({ query: { framed: "1" } } as never, res() as never);
    expect(mocks.readLiveEditState).toHaveBeenLastCalledWith("t1", undefined, { framed: true });
  });

  it.each([[{}], [{ framed: "0" }], [{ framed: "true" }], [{ framed: ["1", "1"] }]])(
    "treats %j as not framed, so a background poll never keeps the paid sandbox awake",
    async (query) => {
      await getLiveEditState({ query } as never, res() as never);
      expect(mocks.readLiveEditState).toHaveBeenLastCalledWith("t1", undefined, { framed: false });
    },
  );
});
