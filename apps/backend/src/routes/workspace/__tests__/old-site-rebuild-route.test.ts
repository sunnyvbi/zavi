import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireTenantRole: vi.fn(async (..._a: unknown[]) => true),
  isProductBuilderEnabled: vi.fn(async () => true),
  requestConductorTick: vi.fn(async (..._a: unknown[]) => undefined),
  logEvent: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "tnt-1", user_id: "user-1" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: mocks.requireTenantRole }));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: mocks.isProductBuilderEnabled }));
vi.mock("@/services/agents/conductor-kick", () => ({ requestConductorTick: mocks.requestConductorTick }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

import { handleRebuildOldSite } from "../old-site-rebuild";
import { DoubleBuildInFlight } from "@/services/agents/start-product-build";
import type { OldSiteRebuildDeps, RebuildClaim } from "@/services/sites/old-site-rebuild";

function deps(over: Partial<OldSiteRebuildDeps> = {}): OldSiteRebuildDeps {
  return {
    loadOldSite: vi.fn(async () => ({ name: "Lucky Paws", build_run_id: "cr_old" })),
    loadBrief: vi.fn(async () => ({ company_name: "Lucky Paws", idea: "A dog walking site for Austin", objective: null })),
    claim: vi.fn(async (): Promise<RebuildClaim> => ({ outcome: "claimed", token: "tok" })),
    settle: vi.fn(async () => true),
    release: vi.fn(async () => true),
    startBuild: vi.fn(async () => ({ conductor_run_id: "cr_new" })),
    ...over,
  };
}

async function call(d: OldSiteRebuildDeps) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  await handleRebuildOldSite({ body: {}, headers: {} } as unknown as Request, res as unknown as Response, d);
  return res as { statusCode: number; body: Record<string, unknown> & { error?: { code: string; message: string } } };
}

beforeEach(() => {
  mocks.requireTenantRole.mockClear();
  mocks.requestConductorTick.mockClear();
  mocks.isProductBuilderEnabled.mockResolvedValue(true);
});

describe("POST /api/workspace/website/rebuild-old-site", () => {
  it("starts the new site for the auth tenant and ticks it", async () => {
    const d = deps();
    const res = await call(d);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, conductor_run_id: "cr_new", already: false });
    expect((d.startBuild as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", started_by_user_id: "user-1" });
    expect(mocks.requestConductorTick).toHaveBeenCalledWith(expect.anything(), "cr_new");
    expect(mocks.requireTenantRole).toHaveBeenCalledWith(expect.anything(), ["owner", "admin"], expect.anything());
  });

  it("a repeat click returns the first build (already) and starts nothing", async () => {
    const d = deps({ claim: vi.fn(async (): Promise<RebuildClaim> => ({ outcome: "existing", conductor_run_id: "cr_new" })) });
    const res = await call(d);
    expect(res.body).toEqual({ ok: true, conductor_run_id: "cr_new", already: true });
    expect(d.startBuild).not.toHaveBeenCalled();
    expect(mocks.requestConductorTick).not.toHaveBeenCalled();
  });

  it("a click while the first is starting is 202", async () => {
    const res = await call(deps({ claim: vi.fn(async (): Promise<RebuildClaim> => ({ outcome: "starting" })) }));
    expect(res.statusCode).toBe(202);
  });

  it("no old site is 404", async () => {
    const res = await call(deps({ loadOldSite: vi.fn(async () => null) }));
    expect(res.statusCode).toBe(404);
    expect(res.body.error?.code).toBe("no_old_site");
  });

  it("another build running is 409, and the claim is released", async () => {
    const d = deps({ startBuild: vi.fn(async () => { throw new DoubleBuildInFlight("tnt-1"); }) });
    const res = await call(d);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("build_already_in_progress");
    expect(d.release).toHaveBeenCalledWith("tnt-1", "tok");
  });

  it("an unknown failure is a plain 500 with no internals", async () => {
    const res = await call(deps({ startBuild: vi.fn(async () => { throw new Error("render api 500 secret-ish"); }) }));
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.message).not.toMatch(/render|secret/i);
  });

  it("a plain member is stopped before anything is read", async () => {
    mocks.requireTenantRole.mockImplementationOnce(async (...args: unknown[]) => {
      (args[2] as { status: (n: number) => { json: (b: unknown) => void } }).status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    const d = deps();
    const res = await call(d);
    expect(res.statusCode).toBe(403);
    expect(d.loadOldSite).not.toHaveBeenCalled();
  });

  it("product builder off is 403 and nothing is read", async () => {
    mocks.isProductBuilderEnabled.mockResolvedValue(false);
    const d = deps();
    const res = await call(d);
    expect(res.statusCode).toBe(403);
    expect(d.loadOldSite).not.toHaveBeenCalled();
  });
});
