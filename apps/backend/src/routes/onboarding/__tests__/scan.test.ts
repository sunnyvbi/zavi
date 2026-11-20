
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const guards = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock("@/services/onboarding/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboarding/scan")>()),
  checkScanGuards: (...a: unknown[]) => guards(...a),
}));
const createScan = vi.fn(async (_h: string) => "AbCdEfGhIjKlMnOp12");
const markScanFailed = vi.fn(async (_id: string) => undefined);
const getScanPublic = vi.fn(async (_id: string) => null as null | { status: string; host: string });
vi.mock("@/services/onboarding/scan-store", () => ({
  createScan: (h: string) => createScan(h),
  markScanFailed: (id: string) => markScanFailed(id),
  getScanPublic: (id: string) => getScanPublic(id),
}));
const verifyBearer = vi.fn(async () => null as null | { user_id: string });
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: () => verifyBearer() }));
const send = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));

import { onboardingScanCreate, onboardingScanGet } from "../scan";

function res() {
  const json = vi.fn();
  const status = vi.fn();
  const r = { json, status } as unknown as Response;
  status.mockReturnValue(r);
  return { r, json, status };
}
const post = (body: unknown) => ({ body, ip: "1.2.3.4", headers: {} }) as unknown as Request;

beforeEach(() => {
  guards.mockReset();
  guards.mockResolvedValue({ ok: true });
  createScan.mockClear();
  markScanFailed.mockClear();
  send.mockReset();
  send.mockResolvedValue(undefined);
  verifyBearer.mockResolvedValue(null);
});

describe("POST /api/onboarding/scan", () => {
  it("normalises the host, queues the scan and returns only the id", async () => {
    const { r, json } = res();
    await onboardingScanCreate(post({ website: "https://www.Acme.com/about" }), r);
    expect(createScan).toHaveBeenCalledWith("acme.com");
    expect(send).toHaveBeenCalledWith({ name: "onboarding/scan.requested", data: { scan_id: "AbCdEfGhIjKlMnOp12" } });
    expect(json).toHaveBeenCalledWith({ scan_id: "AbCdEfGhIjKlMnOp12" });
  });

  it("passes the signed-in user to the guards (per-user limit)", async () => {
    verifyBearer.mockResolvedValue({ user_id: "u1" });
    await onboardingScanCreate(post({ website: "acme.com" }), res().r);
    expect(guards.mock.calls[0][1]).toBe("u1");
  });

  it("a refused guard returns a null id and queues nothing", async () => {
    guards.mockResolvedValue({ ok: false, reason: "user_rate_limit" });
    const { r, json } = res();
    await onboardingScanCreate(post({ website: "acme.com" }), r);
    expect(json).toHaveBeenCalledWith({ scan_id: null, reason: "user_rate_limit" });
    expect(createScan).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("an invalid website is a 400 before any guard ticks", async () => {
    const { r, status } = res();
    await onboardingScanCreate(post({ website: "not a site" }), r);
    expect(status).toHaveBeenCalledWith(400);
    expect(guards).not.toHaveBeenCalled();
  });

  it("an enqueue failure marks the scan failed and returns a null id", async () => {
    send.mockRejectedValueOnce(new Error("down"));
    const { r, json } = res();
    await onboardingScanCreate(post({ website: "acme.com" }), r);
    expect(markScanFailed).toHaveBeenCalledWith("AbCdEfGhIjKlMnOp12");
    expect(json).toHaveBeenCalledWith({ scan_id: null });
  });
});

describe("GET /api/onboarding/scan/:id", () => {
  it("returns status + host only", async () => {
    getScanPublic.mockResolvedValueOnce({ status: "running", host: "acme.com", enrichment: { x: 1 } } as never);
    const { r, json } = res();
    await onboardingScanGet({ params: { id: "AbCdEfGhIjKlMnOp12" } } as unknown as Request, r);
    expect(json).toHaveBeenCalledWith({ status: "running", host: "acme.com" });
  });

  it("404 when unknown or expired", async () => {
    getScanPublic.mockResolvedValueOnce(null);
    const { r, status } = res();
    await onboardingScanGet({ params: { id: "nope" } } as unknown as Request, r);
    expect(status).toHaveBeenCalledWith(404);
  });
});
