import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireAuth = vi.fn(async () => ({
  tenant_id: "t-1",
  user_id: "u-1",
  access_token: "tok",
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...(a as [])),
}));

const mockGetBoolSetting = vi.fn(async () => true);
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...a: unknown[]) => mockGetBoolSetting(...(a as [])),
}));

const mockGetSecret = vi.fn(async () => "https://staging.example.com" as string | null);
vi.mock("@/services/secrets/vault", () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...(a as [])),
}));

let inflightRows: Array<{ id: string }> = [];
let recentRows: Array<{ id: string }> = [];
let queryN = 0;
let inflightGt: Array<{ col: string; val: unknown }> = [];
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const isInflight = queryN++ % 2 === 0;
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: (col: string, val: unknown) => {
          if (isInflight) inflightGt.push({ col, val });
          return chain;
        },
        limit: async () => ({
          data: isInflight ? inflightRows : recentRows,
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

const mockSend = vi.fn(async () => ({ ids: ["evt-1"] }));
vi.mock("../../../../../workers/client", () => ({
  inngest: { send: (...a: unknown[]) => mockSend(...(a as [])) },
}));

import { qaRunTests } from "../qa-run";

function resStub() {
  const r: { code?: number; body?: unknown; status: (c: number) => typeof r; json: (b: unknown) => void } = {
    status(c: number) {
      r.code = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
    },
  };
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBoolSetting.mockResolvedValue(true);
  mockGetSecret.mockResolvedValue("https://staging.example.com");
  inflightRows = [];
  recentRows = [];
  queryN = 0;
  inflightGt = [];
});

const req = { body: {} } as never;

describe("POST /api/agents/qa/run-tests", () => {
  it("403 setup_required when the flag is off — no event", async () => {
    mockGetBoolSetting.mockResolvedValue(false);
    const res = resStub();
    await qaRunTests(req, res as never);
    expect(res.code).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("409 needs_staging_url when vault key is missing — no event", async () => {
    mockGetSecret.mockResolvedValue(null);
    const res = resStub();
    await qaRunTests(req, res as never);
    expect(res.code).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("needs_staging_url");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("409 already_running when a batch is in flight — no event", async () => {
    inflightRows = [{ id: "r-1" }];
    const res = resStub();
    await qaRunTests(req, res as never);
    expect(res.code).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("already_running");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("429 inside the cooldown window — no event", async () => {
    recentRows = [{ id: "r-old" }];
    const res = resStub();
    await qaRunTests(req, res as never);
    expect(res.code).toBe(429);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("bounds the in-flight gate by a ~2h enqueued_at staleness floor (P1-2 — orphan backstop)", async () => {
    const res = resStub();
    const before = Date.now();
    await qaRunTests(req, res as never);
    const after = Date.now();
    expect(res.code).toBe(202);
    const floor = inflightGt.find((g) => g.col === "enqueued_at");
    expect(floor, "inflight query must apply an enqueued_at staleness floor").toBeTruthy();
    const cutoffMs = Date.parse(floor!.val as string);
    expect(before - cutoffMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    expect(after - cutoffMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 1000);
  });

  it("202 + tenant-scoped event when all gates pass — tenant from AUTH, never body", async () => {
    const res = resStub();
    await qaRunTests(
      { body: { tenant_id: "t-EVIL" } } as never,
      res as never,
    );
    expect(res.code).toBe(202);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const evt = (mockSend.mock.calls as unknown as Array<[{ name: string; data: { tenant_id: string; dedupe_key: string } }]>)[0][0];
    expect(evt.name).toBe("qa/weekly.execute.requested");
    expect(evt.data.tenant_id).toBe("t-1");
    expect(evt.data.dedupe_key).toMatch(/^t-1:\d+$/);
  });
});

describe("worker tenant scoping (source contract)", () => {
  it("scan restricts to event.data.tenant_id when present", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "workers", "functions", "qa-weekly-execute.ts"),
      "utf8",
    );
    expect(src).toMatch(/if \(tenant_id\) q = q\.eq\("id", tenant_id\)/);
  });
});
