
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { serviceClientMock, calls, state, reset } = vi.hoisted(() => {
  const c = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    fromTables: [] as string[],
  };
  const s = {
    runRow: { agent_slug: "operator", model_used: "claude-sonnet-4-6", status: "success" } as
      | Record<string, unknown>
      | null,
    recordResult: {
      data: { review_id: 7, out_tenant_id: "t-1", out_agent_slug: "operator" },
      error: null as { message: string } | null,
    },
    registerResult: { data: [{ matched_tenant: "t-1", was_recurrence: false }], error: null },
    calibResult: {
      data: [
        { out_quality_model: "gpt-5.5", out_agent_slug: "operator", correct: 8, wrong: 2, total: 10, accuracy_pct: 80 },
      ],
      error: null,
    },
  };
  const client = {
    from: (table: string) => {
      c.fromTables.push(table);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.in = () => Promise.resolve({ data: [], error: null });
      b.order = () => Promise.resolve({ data: [], error: null });
      b.maybeSingle = () => Promise.resolve({ data: s.runRow, error: null });
      return b;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      c.rpc.push({ name, args });
      const result =
        name === "record_agent_run_review"
          ? s.recordResult
          : name === "register_regression_signature"
            ? s.registerResult
            : s.calibResult;
      return {
        single: () => Promise.resolve(result),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onF, onR),
      };
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    calls: c,
    state: s,
    reset: () => {
      c.rpc = [];
      c.fromTables = [];
      s.runRow = { agent_slug: "operator", model_used: "claude-sonnet-4-6", status: "success" };
      s.recordResult = {
        data: { review_id: 7, out_tenant_id: "t-1", out_agent_slug: "operator" },
        error: null,
      };
      s.registerResult = { data: [{ matched_tenant: "t-1", was_recurrence: false }], error: null };
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffRunReviewWrite, staffJudgeCalibration } from "../run-review";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

function makeReqRes(body: unknown, params: Record<string, string> = { run_id: RUN_ID }, query: Record<string, unknown> = {}) {
  const req = { params, body, query } as unknown as Parameters<typeof staffRunReviewWrite>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<typeof staffRunReviewWrite>[1] & typeof res };
}

beforeEach(() => reset());

describe("staffRunReviewWrite", () => {
  it("400s on an invalid verdict, never calls any RPC", async () => {
    const { req, res } = makeReqRes({ verdict: "lgtm" });
    await staffRunReviewWrite(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_body");
    expect(calls.rpc).toHaveLength(0);
  });

  it("400s on a non-UUID run_id", async () => {
    const { req, res } = makeReqRes({ verdict: "score_correct" }, { run_id: "not-a-uuid" });
    await staffRunReviewWrite(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_run_id");
  });

  it("score_correct records a review WITHOUT reading the run or minting a regression sig", async () => {
    const { req, res } = makeReqRes({ verdict: "score_correct", comment: "looks right" });
    await staffRunReviewWrite(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.fromTables).not.toContain("agent_runs");
    const names = calls.rpc.map((r) => r.name);
    expect(names).toContain("record_agent_run_review");
    expect(names).not.toContain("register_regression_signature");
    expect((res.payload as { regression_signature: string | null }).regression_signature).toBeNull();
    const recordArgs = calls.rpc.find((r) => r.name === "record_agent_run_review")!.args;
    expect(recordArgs).not.toHaveProperty("p_tenant_id");
    expect(recordArgs.p_verdict).toBe("score_correct");
  });

  it("bug verdict reads the run, mints a content-free signature, and registers it", async () => {
    const { req, res } = makeReqRes({ verdict: "bug", comment: "wrong tenant in reply" });
    await staffRunReviewWrite(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.fromTables).toContain("agent_runs");
    const names = calls.rpc.map((r) => r.name);
    expect(names).toContain("record_agent_run_review");
    expect(names).toContain("register_regression_signature");
    const payload = res.payload as { regression_signature: string | null; recurrence: boolean };
    expect(payload.regression_signature).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.recurrence).toBe(false);
    const recordSig = calls.rpc.find((r) => r.name === "record_agent_run_review")!.args
      .p_regression_signature;
    const registerSig = calls.rpc.find((r) => r.name === "register_regression_signature")!.args
      .p_signature;
    expect(recordSig).toBe(registerSig);
  });

  it("bug verdict surfaces an armed-signature recurrence", async () => {
    state.registerResult = { data: [{ matched_tenant: "t-1", was_recurrence: true }], error: null };
    const { req, res } = makeReqRes({ verdict: "bug" });
    await staffRunReviewWrite(req, res);
    expect((res.payload as { recurrence: boolean }).recurrence).toBe(true);
  });

  it("404s a bug verdict on a missing run", async () => {
    state.runRow = null;
    const { req, res } = makeReqRes({ verdict: "bug" });
    await staffRunReviewWrite(req, res);
    expect(res.statusCode).toBe(404);
    expect(calls.rpc.map((r) => r.name)).not.toContain("register_regression_signature");
  });
});

describe("staffJudgeCalibration", () => {
  it("maps out_* rpc columns into clean fields", async () => {
    const { req, res } = makeReqRes({}, {}, { min_labels: "1" });
    await staffJudgeCalibration(req, res);
    expect(res.statusCode).toBe(200);
    const rows = (res.payload as { calibration: Array<{ quality_model: string; agent_slug: string; accuracy_pct: number }> }).calibration;
    expect(rows[0].quality_model).toBe("gpt-5.5");
    expect(rows[0].agent_slug).toBe("operator");
    expect(rows[0].accuracy_pct).toBe(80);
  });
});
