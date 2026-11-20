import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const setGlobalSetting = vi.fn().mockResolvedValue(undefined);
const setTenantSetting = vi.fn().mockResolvedValue(undefined);
const writeStaffAudit = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "u-1", email: "staff@zaviagent.com" })),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return {
    REDACTED_SETTING_VALUE: actual.REDACTED_SETTING_VALUE,
    listSettings: vi.fn().mockResolvedValue([]),
    setGlobalSetting,
    setTenantSetting,
    editSecretList: vi.fn(),
  };
});

const TENANT = "3f2b8c1e-9a4d-4e6b-8c2f-1d5e7a9b0c3d";

type MockRes = Response & { _status: number; _json: { error?: { code: string } } };

function mockRes(): MockRes {
  const r = {} as MockRes;
  r._status = 200;
  r.status = vi.fn((c: number) => {
    r._status = c;
    return r;
  }) as unknown as MockRes["status"];
  r.json = vi.fn((b: MockRes["_json"]) => {
    r._json = b;
    return r;
  }) as unknown as MockRes["json"];
  return r;
}

async function put(body: Record<string, unknown>): Promise<MockRes> {
  const { staffSettingsPut } = await import("../settings");
  const res = mockRes();
  await staffSettingsPut({ body } as Request, res);
  return res;
}

beforeEach(() => {
  setGlobalSetting.mockClear();
  setTenantSetting.mockClear();
  writeStaffAudit.mockClear();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("EXECUTION_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("build_replay_fixture can never be turned on for every tenant", () => {
  it("a global fixture write is rejected and nothing is stored", async () => {
    const res = await put({ key: "build_replay_fixture", scope: "global", value: "db-app" });
    expect(res._status).toBe(400);
    expect(res._json.error?.code).toBe("cannot_set_consent_globally");
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });

  it("a global write padded with whitespace is rejected too", async () => {
    const res = await put({ key: "build_replay_fixture", scope: "global", value: " db-app " });
    expect(res._status).toBe(400);
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });

  it("a global 'off' is allowed", async () => {
    const res = await put({ key: "build_replay_fixture", scope: "global", value: "off" });
    expect(res._status).toBe(200);
    expect(setGlobalSetting).toHaveBeenCalledWith("build_replay_fixture", "off", "staff@zaviagent.com");
  });

  it("a global autopilot_trust_level 'L0' (the safe default) is accepted, not treated as a consent grant", async () => {
    const res = await put({ key: "autopilot_trust_level", scope: "global", value: "L0" });
    expect(res._status).toBe(200);
    expect(setGlobalSetting).toHaveBeenCalledWith("autopilot_trust_level", "L0", "staff@zaviagent.com");
  });

  it("the existing boolean consent guard still rejects a global true", async () => {
    const res = await put({ key: "cross_customer_learning_consent", scope: "global", value: true });
    expect(res._status).toBe(400);
    expect(res._json.error?.code).toBe("cannot_set_consent_globally");
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });
});

describe("build_replay_fixture per tenant", () => {
  it("a local dev backend stores a known fixture for one tenant and audits it", async () => {
    const res = await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value: "db-app" });
    expect(res._status).toBe(200);
    expect(setTenantSetting).toHaveBeenCalledWith(TENANT, "build_replay_fixture", "db-app", "staff@zaviagent.com");
    expect(writeStaffAudit).toHaveBeenCalledWith(
      expect.objectContaining({ target_table: "tenant_app_setting", tenant_id: TENANT, target_id: "build_replay_fixture" }),
    );
  });

  it("a production backend refuses to turn it on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value: "db-app" });
    expect(res._status).toBe(400);
    expect(res._json.error?.code).toBe("replay_not_allowed_here");
    expect(setTenantSetting).not.toHaveBeenCalled();
  });

  it("a staging backend refuses to turn it on", async () => {
    vi.stubEnv("EXECUTION_ENV", "staging");
    const res = await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value: "db-app" });
    expect(res._status).toBe(400);
    expect(setTenantSetting).not.toHaveBeenCalled();
  });

  it("a production backend can still turn it off or clear it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value: "off" }))._status).toBe(200);
    expect((await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value: null }))._status).toBe(200);
    expect(setTenantSetting).toHaveBeenCalledTimes(2);
  });

  it.each([["../../etc"], ["dog_grooming"], [true], [42]])("rejects an unknown value %j", async (value) => {
    const res = await put({ key: "build_replay_fixture", scope: "tenant", tenant_id: TENANT, value });
    expect(res._status).toBe(400);
    expect(res._json.error?.code).toBe("unknown_fixture");
    expect(setTenantSetting).not.toHaveBeenCalled();
  });
});
