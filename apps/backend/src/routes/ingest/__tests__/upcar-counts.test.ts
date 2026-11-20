import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: (...a: unknown[]) => rpc(...a) }));

import { postUpcarHourlyCounts, keyMatches } from "../upcar-counts";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const body = { from: "2026-08-24T14:00:00.000Z", to: "2026-09-28T15:00:00.000Z", metrics: ["bookings", "new_hosts"], rows: [{ hour: "2026-09-28T13:00:00.000Z", metrics: { bookings: 2, new_hosts: 1 } }] };
function call(headers: Record<string, string>, b: unknown) {
  const r = { status: 200, body: null as unknown };
  const res = { set: () => res, status(c: number) { r.status = c; return res; }, json(x: unknown) { r.body = x; return res; } } as unknown as Response;
  const req = { header: (k: string) => headers[k.toLowerCase()], body: b } as unknown as Request;
  return postUpcarHourlyCounts(req, res).then(() => r);
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: 1, error: null });
  process.env.UPCAR_INGEST_KEY = "secret-key";
  process.env.UPCAR_INGEST_TENANT_ID = T;
});

describe("POST /api/ingest/upcar/hourly-counts", () => {
  it("503 when not configured", async () => {
    delete process.env.UPCAR_INGEST_KEY;
    expect((await call({ "x-zavi-ingest-key": "secret-key" }, body)).status).toBe(503);
  });
  it("401 on a missing or wrong key, and never touches the DB", async () => {
    expect((await call({}, body)).status).toBe(401);
    expect((await call({ "x-zavi-ingest-key": "nope" }, body)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("400 on a bad body", async () => {
    expect((await call({ "x-zavi-ingest-key": "secret-key" }, { ...body, from: "x" })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("replaces the window for the configured tenant only (tenant never from the body)", async () => {
    const r = await call({ "x-zavi-ingest-key": "secret-key" }, { ...body, tenant_id: "evil" });
    expect(r.status).toBe(200);
    expect(rpc.mock.calls[0][0]).toBe(T);
    expect(rpc.mock.calls[0][2]).toMatchObject({ p_tenant_id: T, p_from: body.from, p_to: body.to, p_metrics: body.metrics, p_rows: body.rows });
  });
  it("keyMatches is constant-shape (different lengths do not throw)", () => {
    expect(keyMatches("a", "a-much-longer-key")).toBe(false);
    expect(keyMatches("same", "same")).toBe(true);
  });
});
