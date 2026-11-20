import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const { requireAuthMock, state } = vi.hoisted(() => {
  const s = {
    auth: { user_id: "u-1", tenant_id: "t-1", access_token: "tok-1" } as
      | { user_id: string; tenant_id: string; access_token: string }
      | null,
  };
  return {
    requireAuthMock: vi.fn(async (_req: unknown, _res: unknown) => s.auth),
    state: s,
  };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { getBoolSettingMock, boolState } = vi.hoisted(() => {
  const b = { value: true };
  return {
    getBoolSettingMock: vi.fn(async () => b.value),
    boolState: b,
  };
});
vi.mock("@/services/settings", () => ({ getBoolSetting: getBoolSettingMock }));

const { execMock, execState } = vi.hoisted(() => {
  const e = {
    result: {} as Record<string, unknown>,
    throwErr: null as Error | null,
  };
  return {
    execMock: vi.fn(async () => {
      if (e.throwErr) throw e.throwErr;
      return e.result;
    }),
    execState: e,
  };
});
vi.mock("@/services/tools/growth/growth_constraint_diagnosis", () => ({
  growthConstraintDiagnosisTool: { name: "growth_constraint_diagnosis", execute: execMock },
}));

const { getCatalogMock } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(async () => ({
    dialect: "mongodb",
    catalog: {
      tables: [
        { name: "trips", columns: [{ name: "carId" }, { name: "createdAt" }] },
        { name: "carlistings", columns: [{ name: "_id" }] },
      ],
    },
    hints: {},
    catalog_hash: "h1",
  })),
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({ getCatalog: getCatalogMock }));

import { growthConstraintDiagnosis } from "../constraint-diagnosis";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(p: unknown) {
      this.body = p;
      return this;
    },
  };
}

const req = (query: Record<string, unknown> = {}) => ({ query }) as never;

beforeEach(() => {
  state.auth = { user_id: "u-1", tenant_id: "t-1", access_token: "tok-1" };
  boolState.value = true;
  execState.result = {};
  execState.throwErr = null;
  vi.clearAllMocks();
});

describe("GET /api/agents/growth-lead/constraint-diagnosis", () => {
  it("returns disabled when the kill-switch is off (does not run the tool)", async () => {
    boolState.value = false;
    const res = makeRes();
    await growthConstraintDiagnosis(req(), res as never);
    expect(res.body).toEqual({ status: "disabled", tenant_id: "t-1" });
    expect(execMock).not.toHaveBeenCalled();
  });

  it("passes the diagnosed state through and echoes tenant_id (no schema)", async () => {
    execState.result = { status: "diagnosed", constraints: [{ constraint: "idle-supply" }], abstained: [] };
    const res = makeRes();
    await growthConstraintDiagnosis(req(), res as never);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("diagnosed");
    expect(body.tenant_id).toBe("t-1");
    expect(body.schema).toBeNull();
    expect(getCatalogMock).not.toHaveBeenCalled();
  });

  it("attaches the slim schema on requires_mapping_confirmation", async () => {
    execState.result = { status: "requires_mapping_confirmation", proposed_map: {}, probes: [] };
    const res = makeRes();
    await growthConstraintDiagnosis(req(), res as never);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("requires_mapping_confirmation");
    expect(body.schema).toEqual({
      tables: [
        { name: "trips", columns: ["carId", "createdAt"] },
        { name: "carlistings", columns: ["_id"] },
      ],
    });
  });

  it("maps ExpectedToolError to a clean not_available state (not a 500)", async () => {
    execState.throwErr = new ExpectedToolError(
      "operator_db_not_connected",
      "Connect your operator database first.",
    );
    const res = makeRes();
    await growthConstraintDiagnosis(req(), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "not_available",
      reason: "operator_db_not_connected",
      message: "Connect your operator database first.",
      tenant_id: "t-1",
    });
  });

  it("500s on an unexpected (non-ExpectedToolError) throw", async () => {
    execState.throwErr = new Error("boom");
    const res = makeRes();
    await growthConstraintDiagnosis(req(), res as never);
    expect(res.statusCode).toBe(500);
    expect((res.body as Record<string, unknown>).status).toBe("error");
  });

  it("forwards window_days when provided", async () => {
    execState.result = { status: "diagnosed", constraints: [], abstained: [] };
    const res = makeRes();
    await growthConstraintDiagnosis(req({ window_days: "14" }), res as never);
    expect(execMock).toHaveBeenCalledWith(expect.anything(), { window_days: 14 });
  });
});
