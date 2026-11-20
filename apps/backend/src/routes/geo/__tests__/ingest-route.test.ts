import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const state = vi.hoisted(() => ({
  scope: null as { tenant_id: string; token_id: string } | null,
  enabled: true,
  ingestCalls: 0,
}));

vi.mock("@/services/tools/growth/geo/crawler-hits/ingest", () => ({
  resolveIngestToken: async () => state.scope,
  ingestLogBatch: async () => {
    state.ingestCalls++;
    return { records: 1, matched: 1, ignored: 0, unparsed: 0, undated: 0, rows_written: 1, truncated: false };
  },
  rotateIngestToken: vi.fn(),
  revokeIngestToken: vi.fn(),
  ingestTokenStatus: vi.fn(),
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => state.enabled }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/company/facts", () => ({ setCompanyFact: vi.fn(), joinCompetitors: vi.fn() }));
vi.mock("@/services/tools/growth/geo/panel", () => ({ getGeoMetrics: vi.fn() }));
vi.mock("@/services/tools/growth/geo/visibility/read", () => ({ getEvidence: vi.fn(), getSweepStatus: vi.fn() }));
vi.mock("@/services/tools/growth/geo/visibility/prompts", () => ({}));
vi.mock("@/services/tools/growth/geo/visibility/sweep", () => ({ openSweep: vi.fn() }));
vi.mock("@/services/tools/growth/geo/visibility/context", () => ({ loadBrandContext: vi.fn(), setHash: vi.fn() }));
vi.mock("@/services/tools/growth/geo/crawler-hits/read", () => ({ getCrawlerHits: vi.fn(), getCrawlerBotDetail: vi.fn() }));

import { geoCrawlerIngest } from "../index";

function call(headers: Record<string, string>, body: Buffer = Buffer.from("{}")) {
  const res = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown };
  const r = res as unknown as Response;
  (r as unknown as { status: (n: number) => Response }).status = (n: number) => {
    res.statusCode = n;
    return r;
  };
  (r as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
    res.body = b;
    return r;
  };
  return geoCrawlerIngest({ headers, body } as unknown as Request, r).then(() => res);
}

beforeEach(() => {
  state.scope = null;
  state.enabled = true;
  state.ingestCalls = 0;
});

describe("POST /api/geo/crawler-hits/ingest", () => {
  it("401s without a bearer token and stores nothing", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(401);
    expect(state.ingestCalls).toBe(0);
  });

  it("401s an unknown or revoked token with the same answer", async () => {
    const res = await call({ authorization: `Bearer zgeo_${"a".repeat(64)}` });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthenticated", message: "Invalid token." } });
    expect(state.ingestCalls).toBe(0);
  });

  it("503s and stores nothing while the kill switch is off", async () => {
    state.scope = { tenant_id: "t1", token_id: "k1" };
    state.enabled = false;
    const res = await call({ authorization: `Bearer zgeo_${"a".repeat(64)}` });
    expect(res.statusCode).toBe(503);
    expect(state.ingestCalls).toBe(0);
  });

  it("ingests for the tenant the token resolved to", async () => {
    state.scope = { tenant_id: "t1", token_id: "k1" };
    const res = await call({ authorization: `Bearer zgeo_${"a".repeat(64)}` });
    expect(res.statusCode).toBe(200);
    expect(state.ingestCalls).toBe(1);
  });
});
