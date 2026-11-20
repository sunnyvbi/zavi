
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const STAFF_USER_ID = "11111111-1111-1111-1111-111111111111";
const STAFF_EMAIL = "ravi@zaviagent.com";
const TENANT_A = "73db45ff-457e-4541-bc8f-bdb625390204";

vi.mock("@/services/auth/staff-middleware", () => {
  return {
    assertStaff: vi.fn(() => ({
      user_id: STAFF_USER_ID,
      email: STAFF_EMAIL,
    })),
  };
});

vi.mock("@/services/memory/replay", () => ({
  streamExport: vi.fn(async (input, writable) => {
    const row = {
      schema_version: 1,
      tenant_id: input.tenant_id,
      tool_name: "search",
      query: "stub",
      retrieved_chunk_ids: [],
      retrieved_note_ids: [],
      latency_ms: 1,
      k: 8,
      run_id: null,
      agent_slug: null,
      created_at: "2026-05-17T00:00:00Z",
    };
    writable.write(JSON.stringify(row) + "\n");
    return { rows_written: 1 };
  }),
  runReplay: vi.fn(async (input) => ({
    schema_version: 1,
    metric_name: "scrubbed_query_jaccard_at_k",
    captured_at_range: null,
    tenant_id: input.tenant_id,
    queries_replayed: 1,
    queries_skipped: 0,
    queries_errored: 0,
    queries_rejected_cross_tenant: 0,
    mean_jaccard: 0.92,
    top1_stability: 0.88,
    latency_delta_ms_mean: 5,
    latency_delta_ms_p50: 4,
    latency_delta_ms_p95: 12,
    regressions: [],
  })),
}));

function mockResponse(): Response {
  const headers: Record<string, string> = {};
  const written: string[] = [];
  let statusCode = 200;
  let body: unknown = null;
  let ended = false;
  const res: Partial<Response> = {
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return res as Response;
    }),
    getHeader: (k: string) => headers[k.toLowerCase()],
    status: vi.fn((code: number) => {
      statusCode = code;
      return res as Response;
    }),
    json: vi.fn((obj: unknown) => {
      body = obj;
      ended = true;
      return res as Response;
    }),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
      return res as Response;
    }),
    headersSent: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any)._inspect = () => ({ headers, statusCode, body, written, ended });
  return res as Response;
}

function mockRequest(body: unknown): Request {
  return {
    body,
    staff: { user_id: STAFF_USER_ID, email: STAFF_EMAIL },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staffBrainEvalExport", () => {
  it("streams NDJSON with content-type x-ndjson", async () => {
    const { staffBrainEvalExport } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({ tenant_id: TENANT_A, since_days: 7 });
    const res = mockResponse();
    await staffBrainEvalExport(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.headers["content-type"]).toBe("application/x-ndjson");
    expect(ins.headers["content-disposition"]).toContain("brain-eval-");
    expect(ins.written.length).toBeGreaterThan(0);
    expect(() => JSON.parse(ins.written[0].trim())).not.toThrow();
  });

  it("rejects missing tenant_id with 400", async () => {
    const { staffBrainEvalExport } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({ since_days: 7 });
    const res = mockResponse();
    await staffBrainEvalExport(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });

  it("rejects unknown fields (strict zod)", async () => {
    const { staffBrainEvalExport } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({
      tenant_id: TENANT_A,
      since_days: 7,
      out_path: "/etc/passwd",
    });
    const res = mockResponse();
    await staffBrainEvalExport(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });

  it("clamps since_days to 1..90", async () => {
    const { staffBrainEvalExport } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({ tenant_id: TENANT_A, since_days: 999 });
    const res = mockResponse();
    await staffBrainEvalExport(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });
});

describe("staffBrainEvalReplay", () => {
  it("returns envelope on valid body", async () => {
    const { staffBrainEvalReplay } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({
      tenant_id: TENANT_A,
      baseline_ndjson: '{"tenant_id":"x"}\n',
    });
    const res = mockResponse();
    await staffBrainEvalReplay(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.body).toMatchObject({
      ok: true,
      report: { schema_version: 1, metric_name: "scrubbed_query_jaccard_at_k" },
    });
  });

  it("rejects missing baseline_ndjson", async () => {
    const { staffBrainEvalReplay } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({ tenant_id: TENANT_A });
    const res = mockResponse();
    await staffBrainEvalReplay(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });

  it("rejects baseline_path (no filesystem over HTTP — Codex P1-2)", async () => {
    const { staffBrainEvalReplay } = await import("../../routes/admin/brain-eval");
    const req = mockRequest({
      tenant_id: TENANT_A,
      baseline_path: "/etc/passwd",
      baseline_ndjson: "x",
    });
    const res = mockResponse();
    await staffBrainEvalReplay(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });

  it("rejects oversized baseline_ndjson body", async () => {
    const { staffBrainEvalReplay } = await import("../../routes/admin/brain-eval");
    const huge = "a".repeat(5_000_001);
    const req = mockRequest({ tenant_id: TENANT_A, baseline_ndjson: huge });
    const res = mockResponse();
    await staffBrainEvalReplay(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = (res as any)._inspect();
    expect(ins.statusCode).toBe(400);
  });
});
