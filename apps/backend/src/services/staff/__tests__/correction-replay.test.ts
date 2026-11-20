
import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeNoteMock } = vi.hoisted(() => ({ writeNoteMock: vi.fn() }));
vi.mock("@/services/memory", () => ({ writeNote: writeNoteMock }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/agents/registry", () => ({
  loadGlobalAgentDefinition: vi.fn(() => null),
}));

const { serviceClientMock, setRpc, rpcCalls, reset } = vi.hoisted(() => {
  const state: { rpc: Record<string, { data: unknown; error: unknown }>; calls: Array<{ name: string; args: Record<string, unknown> }> } = {
    rpc: {},
    calls: [],
  };
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      return Promise.resolve(state.rpc[name] ?? { data: null, error: null });
    },
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.order = () => b;
      b.limit = () => Promise.resolve({ data: [], error: null });
      return b;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    setRpc: (n: string, data: unknown, error: unknown = null) => {
      state.rpc[n] = { data, error };
    },
    rpcCalls: () => state.calls,
    reset: () => {
      state.rpc = {};
      state.calls = [];
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { replayCorrectionCase, type CorrectionCase } from "../correction-replay";
import { captureAdminCorrection } from "../capture-admin-correction";

describe("replayCorrectionCase — Slice 2", () => {
  const editCase: CorrectionCase = {
    tenant_id: "t-1",
    agent_slug: "support-lead",
    decision_class: "support-lead.reply",
    before_body: { text: "wrong" },
    after_body: { text: "right" },
  };

  it("EDIT case passes when the agent now matches the corrected field", () => {
    const r = replayCorrectionCase(editCase, { text: "right", extra: "ok" });
    expect(r.result).toBe("pass");
  });

  it("EDIT case fails when the agent still produces the old value", () => {
    const r = replayCorrectionCase(editCase, { text: "wrong" });
    expect(r.result).toBe("fail");
  });

  it("REJECT case passes when the agent emits NOTHING", () => {
    const rejectCase: CorrectionCase = {
      tenant_id: "t-1",
      agent_slug: "support-lead",
      decision_class: "support-lead.reply",
      before_body: { text: "spammy" },
      after_body: { should_not_emit: true, decision_class: "support-lead.reply" },
    };
    expect(replayCorrectionCase(rejectCase, null).result).toBe("pass");
    expect(replayCorrectionCase(rejectCase, { text: "spammy again" }).result).toBe("fail");
  });
});

describe("captureAdminCorrection eval-case row shape — Slice 2", () => {
  beforeEach(() => {
    writeNoteMock.mockReset();
    writeNoteMock.mockResolvedValue({ note_id: "n-1", chunks: 0, entities: 0 });
    reset();
    setRpc("record_admin_correction", [{ occurrence_count: 1, inserted: true }]);
    setRpc("record_admin_correction_eval_case", 7);
  });

  it("writes an eval case with correct before/after + mandatory tenant_id (edit)", async () => {
    await captureAdminCorrection({
      tenant_id: "t-1",
      decision_id: "11111111-1111-4111-8111-111111111111",
      decision_class: "support-lead.reply",
      actor: { user_id: "u-1", email: "ravi@upcar.ai" },
      action: "edit",
      before_body: { text: "wrong" },
      after_body: { text: "right" },
    });
    const caseCall = rpcCalls().find((c) => c.name === "record_admin_correction_eval_case");
    expect(caseCall).toBeDefined();
    expect(caseCall!.args.p_tenant_id).toBe("t-1");
    expect(caseCall!.args.p_before_body).toEqual({ text: "wrong" });
    expect(caseCall!.args.p_after_body).toEqual({ text: "right" });
  });

  it("reject eval case after_body encodes should_not_emit", async () => {
    await captureAdminCorrection({
      tenant_id: "t-9",
      decision_id: "22222222-2222-4222-8222-222222222222",
      decision_class: "support-lead.reply",
      actor: { user_id: "u-1", email: "ravi@upcar.ai" },
      action: "reject",
      reason: "off-policy",
    });
    const caseCall = rpcCalls().find((c) => c.name === "record_admin_correction_eval_case");
    expect(caseCall).toBeDefined();
    expect(caseCall!.args.p_tenant_id).toBe("t-9");
    expect((caseCall!.args.p_after_body as { should_not_emit?: boolean }).should_not_emit).toBe(true);
  });
});
