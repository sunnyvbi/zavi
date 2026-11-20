import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  update: vi.fn(),
  maybeSingle: vi.fn(),
  tenantClient: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: m.tenantClient,
}));
vi.mock("@/services/analytics/tenant-timezone", async () => {
  const actual = await vi.importActual<typeof import("@/services/analytics/tenant-timezone")>(
    "@/services/analytics/tenant-timezone",
  );
  return { isStorableTimeZone: actual.isStorableTimeZone, resolveReportingTimezone: m.resolve };
});

import { getReportingTimezone, patchReportingTimezone } from "../reporting-timezone";

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  r.status = vi.fn((c: number) => {
    r.statusCode = c;
    return r as Response;
  }) as unknown as Response["status"];
  r.json = vi.fn((b: unknown) => {
    r.body = b;
    return r as Response;
  }) as unknown as Response["json"];
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAuth.mockResolvedValue({ tenant_id: "tenant-auth", user_id: "u1", access_token: "tok" });
  m.update.mockResolvedValue({ error: null });
  m.maybeSingle.mockResolvedValue({ data: { reporting_timezone: null }, error: null });
  m.tenantClient.mockReturnValue({
    from: () => ({ update: m.update, select: () => ({ maybeSingle: m.maybeSingle }) }),
  });
  m.resolve.mockResolvedValue({ tz: "America/New_York", source: "ga4_property" });
});

describe("PATCH /api/tenant/me/reporting-timezone", () => {
  it("writes the zone to the AUTHED tenant only, never a body tenant", async () => {
    const r = res();
    await patchReportingTimezone({ body: { reporting_timezone: "Europe/London" } } as Request, r as Response);
    expect(m.tenantClient).toHaveBeenCalledWith("tenant-auth");
    expect(m.update).toHaveBeenCalledWith({ reporting_timezone: "Europe/London" });
    expect(r.body).toEqual({ reporting_timezone: "Europe/London" });
  });

  it("rejects a tenant_id in the body (strict schema)", async () => {
    const r = res();
    await patchReportingTimezone({ body: { reporting_timezone: "UTC", tenant_id: "other" } } as Request, r as Response);
    expect(r.statusCode).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("rejects a zone that is not a real IANA name", async () => {
    const r = res();
    await patchReportingTimezone({ body: { reporting_timezone: "Mars/Olympus" } } as Request, r as Response);
    expect(r.statusCode).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("null clears it so detection runs again", async () => {
    const r = res();
    await patchReportingTimezone({ body: { reporting_timezone: null } } as Request, r as Response);
    expect(m.update).toHaveBeenCalledWith({ reporting_timezone: null });
  });

  it("unauthenticated (or a viewer, refused inside requireAuth) writes nothing", async () => {
    m.requireAuth.mockResolvedValue(null);
    await patchReportingTimezone({ body: { reporting_timezone: "UTC" } } as Request, res() as Response);
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/tenant/me/reporting-timezone", () => {
  it("returns the stored value and the effective zone, without persisting", async () => {
    const r = res();
    await getReportingTimezone({} as Request, r as Response);
    expect(m.resolve).toHaveBeenCalledWith("tenant-auth", { persist: false });
    expect(r.body).toEqual({ reporting_timezone: null, effective: "America/New_York", source: "ga4_property" });
  });
});
