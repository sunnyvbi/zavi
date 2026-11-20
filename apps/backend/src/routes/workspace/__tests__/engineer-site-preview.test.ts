
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
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: (tableData as Record<string, unknown>)[table] ?? null });
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

let closedRowArg: { session_id: string; reason?: string } | null = null;
let deletedProviderId: string | null = null;
vi.mock("@/services/sandbox/browser-mcp/browser-sessions", () => ({
  closeBrowserSession: vi.fn(async (a: { session_id: string; reason?: string }) => {
    closedRowArg = a;
  }),
}));
vi.mock("@/services/sandbox/browser-mcp/anchor-rest-client", () => ({
  deleteAnchorSessionById: vi.fn(async (_key: string, id: string) => {
    deletedProviderId = id;
  }),
}));

import {
  openEngineerSitePreview,
  closeEngineerSitePreview,
} from "@/routes/workspace/engineer-site-preview";
import {
  _setAnchorClient,
  _setBrowserSessionTracker,
} from "@/services/sandbox/browser-mcp/anchor-backend";
import { _setPickerOverlayInjector } from "@/services/sandbox/browser-mcp/picker-overlay";
import {
  getPreviewCdp,
  _resetLiveViewStore,
} from "@/services/sandbox/engineer-site-preview";
import type { AnchorClient } from "@/services/sandbox/browser-mcp/anchor-backend";

const LIVE_VIEW_URL =
  "https://live.anchorbrowser.io/v1/sessions/anchor-sess-1/live?token=SUPERSECRETBEARER";
const CDP_URL = "wss://cdp.anchorbrowser.io/anchor-sess-1?token=CDPSECRET";
const ANCHOR_SESSION_ID = "anchor-sess-1";
const DB_SESSION_ID = "db-sess-1";

let createSessionOpts: Parameters<AnchorClient["createSession"]>[0] | null = null;
let navOp: unknown = null;
let stampedProviderId: { session_id: string; provider_session_id: string } | null = null;
let openArgs: { tenant_id: string; run_id: string | null; origin?: string } | null = null;
let injectedCdpUrl: string | null = null;

function installMocks() {
  createSessionOpts = null;
  navOp = null;
  stampedProviderId = null;
  openArgs = null;
  injectedCdpUrl = null;
  closedRowArg = null;
  deletedProviderId = null;
  _resetLiveViewStore();

  _setPickerOverlayInjector({
    async inject({ cdpUrl }) {
      injectedCdpUrl = cdpUrl;
    },
  });

  _setAnchorClient({
    async createSession(opts) {
      createSessionOpts = opts;
      return { id: ANCHOR_SESSION_ID, cdp_url: CDP_URL, live_view_url: LIVE_VIEW_URL };
    },
    async runAction({ op }) {
      navOp = op;
      return { ok: true, result: {} };
    },
    async closeSession() {
    },
  });

  _setBrowserSessionTracker({
    async open(a) {
      openArgs = a;
      return DB_SESSION_ID;
    },
    async setProviderId(a) {
      stampedProviderId = a;
    },
    async close() {
    },
  });
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

function postReq(body: unknown): Request {
  return { method: "POST", body, headers: {}, query: {}, params: {} } as unknown as Request;
}
function delReq(sessionId: string): Request {
  return {
    method: "DELETE",
    params: { sessionId },
    headers: {},
    query: {},
  } as unknown as Request;
}

describe("engineer site preview — route + isolation", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    mockedGetBool.mockReset();
    mockedGetBool.mockResolvedValue(true);
    process.env.ANCHOR_API_KEY = "anchor-test-key";
    viewerTenant = "ten-A";
    tableData = {};
    installMocks();
  });
  afterEach(() => {
    process.env = { ...saved };
    _setAnchorClient(null);
    _setBrowserSessionTracker(null);
    _setPickerOverlayInjector(null);
    _resetLiveViewStore();
    vi.restoreAllMocks();
  });

  it("POST: flag OFF → 403 disabled, opens NOTHING", async () => {
    mockedGetBool.mockResolvedValue(false);
    const res = mockRes();
    await openEngineerSitePreview(postReq({ url: "https://example.com" }), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("disabled");
    expect(createSessionOpts).toBeNull();
  });

  it("POST: a body-supplied tenant_id is IGNORED — the row opens under the authed tenant", async () => {
    viewerTenant = "ten-A";
    const res = mockRes();
    await openEngineerSitePreview(
      postReq({ url: "https://example.com", tenant_id: "ten-EVIL" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(openArgs?.tenant_id).toBe("ten-A");
  });

  it.each([
    ["non-http scheme", "javascript:alert(1)"],
    ["file scheme", "file:///etc/passwd"],
    ["localhost", "http://localhost:3000/"],
    ["*.localhost", "http://foo.localhost/"],
    ["loopback IP", "http://127.0.0.1/"],
    ["private 10/8", "http://10.0.0.5/"],
    ["private 192.168", "https://192.168.1.1/admin"],
    ["link-local IMDS", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["garbage", "not a url"],
  ])("POST: rejects %s with 400 and opens nothing", async (_label, url) => {
    const res = mockRes();
    await openEngineerSitePreview(postReq({ url }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_url");
    expect(createSessionOpts).toBeNull();
  });

  it("POST: opens a NO-PROFILE, non-one-time headful session, stamps provider id, returns live_view_url — cdp_url stays server-only", async () => {
    const res = mockRes();
    await openEngineerSitePreview(postReq({ url: "https://shop.example.com/" }), res);

    expect(res.statusCode).toBe(200);
    expect(createSessionOpts?.headful).toBe(true);
    expect(createSessionOpts?.oneTimeLiveViewUrl).toBe(false);
    expect(createSessionOpts?.profileId).toBeUndefined();
    expect(navOp).toEqual({ op: "nav", url: "https://shop.example.com/" });
    expect(stampedProviderId).toEqual({
      session_id: DB_SESSION_ID,
      provider_session_id: ANCHOR_SESSION_ID,
    });
    const body = res.body as { session_id: string; live_view_url: string };
    expect(body.session_id).toBe(DB_SESSION_ID);
    expect(body.live_view_url).toBe(LIVE_VIEW_URL);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(CDP_URL);
    expect(serialized).not.toContain("CDPSECRET");
    expect(getPreviewCdp(DB_SESSION_ID)).toEqual(
      expect.objectContaining({ tenantId: "ten-A", cdpUrl: CDP_URL }),
    );
    expect(injectedCdpUrl).toBe(CDP_URL);
  });

  it("DELETE: a caller in tenant B is rejected 403 on tenant A's session — nothing torn down", async () => {
    tableData = {
      browser_sessions: { tenant_id: "ten-A", provider_session_id: ANCHOR_SESSION_ID },
    };
    viewerTenant = "ten-B";
    const res = mockRes();
    await closeEngineerSitePreview(delReq(DB_SESSION_ID), res);
    expect(res.statusCode).toBe(403);
    expect(deletedProviderId).toBeNull();
    expect(closedRowArg).toBeNull();
  });

  it("DELETE: own session → 200, terminates the remote Anchor session + closes the row + forgets cdp", async () => {
    tableData = {
      browser_sessions: { tenant_id: "ten-A", provider_session_id: ANCHOR_SESSION_ID },
    };
    viewerTenant = "ten-A";
    await openEngineerSitePreview(postReq({ url: "https://shop.example.com/" }), mockRes());
    expect(getPreviewCdp(DB_SESSION_ID)).not.toBeNull();

    const res = mockRes();
    await closeEngineerSitePreview(delReq(DB_SESSION_ID), res);
    expect(res.statusCode).toBe(200);
    expect(deletedProviderId).toBe(ANCHOR_SESSION_ID);
    expect(closedRowArg?.session_id).toBe(DB_SESSION_ID);
    expect(getPreviewCdp(DB_SESSION_ID)).toBeNull();
  });

  it("DELETE: unknown / already-closed session → 200 no-op (idempotent)", async () => {
    tableData = {};
    viewerTenant = "ten-A";
    const res = mockRes();
    await closeEngineerSitePreview(delReq("ghost-session"), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { closed: boolean }).closed).toBe(false);
    expect(deletedProviderId).toBeNull();
  });
});
