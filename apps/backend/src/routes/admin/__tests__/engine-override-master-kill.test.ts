
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  currentBlob: { foo: "bar", provider_overrides_disabled: false } as Record<string, unknown>,
}));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "u1", email: "ravi@upcar.ai" }),
}));

vi.mock("@/services/supabase", () => {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => ({ data: { blob: h.currentBlob }, error: null }),
  };
  return {
    serviceClient: () => ({
      from: () => ({
        ...q,
        upsert: (row: Record<string, unknown>) => {
          h.upserts.push(row);
          return { error: null };
        },
      }),
    }),
  };
});

vi.mock("@/services/staff/audit", () => ({
  writeStaffAudit: async (x: Record<string, unknown>) => {
    h.audits.push(x);
  },
}));

import { staffEngineOverrideMasterKill, MasterKillBody } from "../engine-override";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("staffEngineOverrideMasterKill", () => {
  beforeEach(() => {
    h.upserts = [];
    h.audits = [];
    h.currentBlob = { foo: "bar", provider_overrides_disabled: false };
  });

  it("ENGAGES the kill: sets provider_overrides_disabled=true, preserves other blob keys", async () => {
    const res = mockRes();
    await staffEngineOverrideMasterKill(
      { body: { provider_overrides_disabled: true } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { provider_overrides_disabled: boolean }).provider_overrides_disabled).toBe(true);
    expect(h.upserts).toHaveLength(1);
    const blob = h.upserts[0].blob as Record<string, unknown>;
    expect(blob.provider_overrides_disabled).toBe(true);
    expect(blob.foo).toBe("bar");
    expect(h.upserts[0].id).toBe(1);
    expect(h.audits[0].action).toBe("engine_override.master_kill.engage");
    expect((h.audits[0].meta as { previous: boolean }).previous).toBe(false);
  });

  it("CLEARS the kill: sets provider_overrides_disabled=false (re-honors existing rows)", async () => {
    h.currentBlob = { foo: "bar", provider_overrides_disabled: true };
    const res = mockRes();
    await staffEngineOverrideMasterKill(
      { body: { provider_overrides_disabled: false } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const blob = h.upserts[0].blob as Record<string, unknown>;
    expect(blob.provider_overrides_disabled).toBe(false);
    expect(h.audits[0].action).toBe("engine_override.master_kill.clear");
    expect((h.audits[0].meta as { previous: boolean }).previous).toBe(true);
  });

  it("REJECTS a malformed body (400), no write", async () => {
    const res = mockRes();
    await staffEngineOverrideMasterKill(
      { body: { disabled: "yes" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("invalid_body");
    expect(h.upserts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("MasterKillBody requires a boolean", () => {
    expect(MasterKillBody.safeParse({ provider_overrides_disabled: true }).success).toBe(true);
    expect(MasterKillBody.safeParse({ provider_overrides_disabled: "true" }).success).toBe(false);
    expect(MasterKillBody.safeParse({}).success).toBe(false);
  });
});
