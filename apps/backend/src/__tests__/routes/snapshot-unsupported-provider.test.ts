
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const requireAuth = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...args: unknown[]) => requireAuth(...args),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));

import { submitSnapshot } from "@/routes/snapshots/submit";

type Captured = { status: number; body: Record<string, unknown> };

function fakeRes(): { res: unknown; out: Captured } {
  const out: Captured = { status: 200, body: {} };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      out.body = body;
      return this;
    },
  };
  return { res, out };
}

const req = {
  body: {
    provider: "chatgpt_ads",
    period_start: "2026-09-01",
    period_end: "2026-09-14",
    payload: { spend: 100 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: "t-1", access_token: "tok" });
});

describe("POST /api/snapshots when the RPC refuses the provider", () => {
  it("answers 400 with the reason, so the surface can say what is wrong", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "unsupported provider chatgpt_ads" },
    });
    const { res, out } = fakeRes();
    await submitSnapshot(req as never, res as never);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      error: { code: "unsupported_provider", message: "unsupported provider chatgpt_ads" },
    });
  });

  it("keeps a real failure a 500, because that one IS worth retrying", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    const { res, out } = fakeRes();
    await submitSnapshot(req as never, res as never);
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: { code: "submit_failed" } });
  });

  it("still saves when the RPC accepts the provider", async () => {
    rpc.mockResolvedValue({ data: "snap-1", error: null });
    const { res, out } = fakeRes();
    await submitSnapshot(req as never, res as never);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, snapshot_id: "snap-1" });
  });
});
