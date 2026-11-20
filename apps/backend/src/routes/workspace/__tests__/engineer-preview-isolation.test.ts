
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";

let viewerTenant = "ten-A";
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({
    user_id: "user-1",
    tenant_id: viewerTenant,
    access_token: "tok",
  })),
}));

vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
import { getBoolSetting } from "@/services/settings";
const mockedGetBool = vi.mocked(getBoolSetting);

let tableData: Record<string, unknown> = {};
let touchedRowId: string | null = null;
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.not = () => b;
      b.in = () => b;
      b.maybeSingle = async () => ({ data: (tableData as Record<string, unknown>)[table] ?? null });
      return b;
    },
    rpc: async (fn: string, args: { p_id?: string }) => {
      if (fn === "touch_sandbox_preview_viewed") touchedRowId = args.p_id ?? null;
      return { data: null, error: null };
    },
  }),
}));

import {
  getEngineerPreviewStatus,
  engineerPreviewProxy,
} from "@/routes/workspace/engineer-preview";
import { signPreviewToken } from "@/services/sandbox/engineer-preview";

const RAW_E2B = "https://3000-abc123def456ghi789jkl.e2b.app";
const RUN = "run-1";

function statusReqRes(runId: string) {
  const req = { params: { runId }, headers: {}, query: {} } as unknown as Request;
  const res = mockRes();
  return { req, res };
}
type MockRes = Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
};
function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  } as MockRes;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  }) as unknown as MockRes["status"];
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  }) as unknown as MockRes["json"];
  res.send = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  }) as unknown as MockRes["send"];
  res.end = vi.fn(() => res) as unknown as MockRes["end"];
  res.setHeader = vi.fn((k: string, v: string) => {
    res.headers[k] = v;
  }) as unknown as MockRes["setHeader"];
  return res;
}

describe("engineer-preview cross-tenant isolation", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    mockedGetBool.mockReset();
    mockedGetBool.mockResolvedValue(true);
    process.env.ENGINEER_PREVIEW_SIGNING_SECRET = "iso-test-secret";
    viewerTenant = "ten-A";
    tableData = {};
    touchedRowId = null;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("STATUS: viewer in tenant B is rejected 403 on tenant A's run", async () => {
    viewerTenant = "ten-B";
    tableData = { agent_runs: { tenant_id: "ten-A" } };
    const { req, res } = statusReqRes(RUN);
    await getEngineerPreviewStatus(req, res);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
  });

  it("STATUS: gate disabled → {status:'none'} (no DB read, no leak)", async () => {
    mockedGetBool.mockResolvedValue(false);
    tableData = { agent_runs: { tenant_id: "ten-A" } };
    const { req, res } = statusReqRes(RUN);
    await getEngineerPreviewStatus(req, res);
    const r = res as unknown as { statusCode: number; body: { status: string } };
    expect(r.statusCode).toBe(200);
    expect(r.body.status).toBe("none");
  });

  it("STATUS: same-tenant live → mints proxy_url that NEVER contains the raw e2b URL", async () => {
    viewerTenant = "ten-A";
    tableData = {
      agent_runs: { tenant_id: "ten-A" },
      tenant_sandbox: {
        id: "row-1",
        tenant_id: "ten-A",
        preview_url: RAW_E2B,
        preview_status: "live",
        preview_run_id: RUN,
      },
    };
    const { req, res } = statusReqRes(RUN);
    await getEngineerPreviewStatus(req, res);
    const r = res as unknown as { statusCode: number; body: { status: string; proxy_url: string } };
    expect(r.statusCode).toBe(200);
    expect(r.body.status).toBe("live");
    expect(r.body.proxy_url).toContain(`/api/workspace/engineer-preview/${RUN}/`);
    expect(r.body.proxy_url).not.toContain("e2b.app");
    expect(touchedRowId).toBe("row-1");
  });

  it("PROXY: a token bound to tenant B is rejected 403 on tenant A's run", async () => {
    const tokenB = signPreviewToken({ runId: RUN, tenantId: "ten-B" });
    tableData = {
      agent_runs: { tenant_id: "ten-A" },
      tenant_sandbox: {
        id: "row-1",
        tenant_id: "ten-A",
        preview_url: RAW_E2B,
        preview_status: "live",
        preview_run_id: RUN,
      },
    };
    const req = {
      method: "GET",
      params: { runId: RUN, 0: "" },
      query: { __pt: tokenB },
      headers: {},
    } as unknown as Request;
    const res = mockRes();
    await engineerPreviewProxy(req, res);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
  });

  it("PROXY: an invalid/garbage token is rejected 401", async () => {
    const req = {
      method: "GET",
      params: { runId: RUN, 0: "" },
      query: { __pt: "garbage" },
      headers: {},
    } as unknown as Request;
    const res = mockRes();
    await engineerPreviewProxy(req, res);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
  });

  it("PROXY: same-tenant token → streams upstream, rewrites HTML, raw e2b URL not in body", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
      text: async () => `<head></head><body><script src="/_next/x.js"></script></body>`,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const tokenA = signPreviewToken({ runId: RUN, tenantId: "ten-A" });
    tableData = {
      agent_runs: { tenant_id: "ten-A" },
      tenant_sandbox: {
        id: "row-1",
        tenant_id: "ten-A",
        preview_url: RAW_E2B,
        preview_status: "live",
        preview_run_id: RUN,
      },
    };
    const req = {
      method: "GET",
      params: { runId: RUN, 0: "" },
      query: { __pt: tokenA },
      headers: {},
    } as unknown as Request;
    const res = mockRes();
    await engineerPreviewProxy(req, res);
    const r = res as unknown as { statusCode: number; body: string; headers: Record<string, string> };
    expect(r.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("e2b.app");
    expect(r.body).toContain(`/api/workspace/engineer-preview/${RUN}/_next/x.js`);
    expect(r.body).not.toContain("e2b.app");
    expect(r.headers["Set-Cookie"]).toContain(`__epv_${RUN}=`);
    expect(r.headers["Content-Security-Policy"]).toContain("sandbox");
    expect(r.headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
  });
});
