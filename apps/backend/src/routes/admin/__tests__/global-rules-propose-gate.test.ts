
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: vi.fn(async () => {}) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => {}) } }));

const { generalizeCalls } = vi.hoisted(() => ({ generalizeCalls: [] as unknown[][] }));
vi.mock("@/services/staff/generalize-rule-body", async () => {
  const actual = await vi.importActual<typeof import("../../../services/staff/generalize-rule-body")>(
    "../../../services/staff/generalize-rule-body",
  );
  return {
    ...actual,
    generalizeRuleBody: (...args: Parameters<typeof actual.generalizeRuleBody>) => {
      generalizeCalls.push(args);
      return actual.generalizeRuleBody(...args);
    },
  };
});

const { serviceClientMock, S, reset } = vi.hoisted(() => {
  const state: {
    sourceDecision: Record<string, unknown> | null;
    sourceSignature: string | null;
    tenantCount: number;
    srcTenant: Record<string, unknown> | null;
    connectorKeyRows: Array<{ connector_object_keys: string[] | null }>;
    connectorKeysError: boolean;
    proposeId: string | null;
    proposedBody: string | null;
  } = {
    sourceDecision: { id: "dec-src", tenant_id: "t-src", decision_class: "support-lead.reply" },
    sourceSignature: "abcd1234abcd1234",
    tenantCount: 2,
    srcTenant: { id: "t-src", name: "UpcarAI", slug: "upcar-ai" },
    connectorKeyRows: [],
    connectorKeysError: false,
    proposeId: "global-rule-1",
    proposedBody: null,
  };

  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.not = () => b;
      b.limit = () => {
        if (table === "memory_note") {
          if (state.connectorKeysError) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: state.connectorKeyRows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };
      b.maybeSingle = () => {
        if (table === "decisions") return Promise.resolve({ data: state.sourceDecision, error: null });
        if (table === "tenants") return Promise.resolve({ data: state.srcTenant, error: null });
        return Promise.resolve({ data: null, error: null });
      };
      return b;
    },
    rpc: (name: string, args?: Record<string, unknown>) => ({
      single: () => {
        if (name === "lookup_correction_signature")
          return Promise.resolve({ data: state.sourceSignature, error: null });
        if (name === "count_admin_correction_tenants")
          return Promise.resolve({ data: state.tenantCount, error: null });
        if (name === "propose_global_rule") {
          state.proposedBody = (args?.p_body_markdown as string) ?? null;
          return Promise.resolve({ data: state.proposeId, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };

  return {
    serviceClientMock: vi.fn(() => client),
    S: state,
    reset: () => {
      state.sourceDecision = { id: "dec-src", tenant_id: "t-src", decision_class: "support-lead.reply" };
      state.sourceSignature = "abcd1234abcd1234";
      state.tenantCount = 2;
      state.srcTenant = { id: "t-src", name: "UpcarAI", slug: "upcar-ai" };
      state.connectorKeyRows = [];
      state.connectorKeysError = false;
      state.proposeId = "global-rule-1";
      state.proposedBody = null;
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffGlobalRulesPropose } from "../global-rules";

function makeReqRes(body: unknown) {
  const req = { body } as unknown as Parameters<typeof staffGlobalRulesPropose>[0];
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
  return { req, res: res as unknown as Parameters<typeof staffGlobalRulesPropose>[1] & typeof res };
}

const SRC_DECISION = "11111111-1111-4111-8111-111111111111";
const baseBody = {
  source_decision_id: SRC_DECISION,
  target_agent_slug: "support-lead",
  body_markdown: "Always confirm the refund window before approving a dispute.",
};

beforeEach(() => {
  reset();
  assertStaffMock.mockClear();
});

describe("staffGlobalRulesPropose — exact-signature cross-tenant gate (P1)", () => {
  it("BLOCKS when the source decision has NO ledger signature (fail closed)", async () => {
    S.sourceSignature = null;
    const { req, res } = makeReqRes(baseBody);
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(409);
    expect((res.payload as { error: { code: string } }).error.code).toBe("no_source_signature");
  });

  it("BLOCKS when the EXACT signature spans < 2 tenants", async () => {
    S.tenantCount = 1;
    const { req, res } = makeReqRes(baseBody);
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(409);
    expect((res.payload as { error: { code: string } }).error.code).toBe("not_cross_tenant");
  });

  it("PASSES when the exact signature spans >= 2 tenants and body is clean", async () => {
    S.tenantCount = 2;
    const { req, res } = makeReqRes(baseBody);
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(200);
    expect((res.payload as { ok: boolean }).ok).toBe(true);
  });
});

describe("staffGlobalRulesPropose — connector source-ref scrub (P1)", () => {
  it("a source-tenant connector ref NEVER fans out — it is scrubbed from the promoted body", async () => {
    S.connectorKeyRows = [{ connector_object_keys: ["slack_channel:C0FUR-ops"] }];
    const { req, res } = makeReqRes({
      ...baseBody,
      body_markdown: "Route every dispute thread to slack_channel:C0FUR-ops for review.",
    });
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(200);
    expect(S.proposedBody).not.toMatch(/C0FUR-ops/);
    expect(S.proposedBody).toContain("[tenant]");
  });

  it("BLOCKS (422) when a source identifier SURVIVES the scrub (fail closed)", async () => {
    S.srcTenant = { id: "t-src", name: "[tenant]", slug: "upcar-ai" };
    const { req, res } = makeReqRes({
      ...baseBody,
      body_markdown: "Mention [tenant] explicitly in the reply.",
    });
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(422);
    expect((res.payload as { error: { code: string } }).error.code).toBe("tenant_data_in_rule_body");
  });

  it("FAILS CLOSED when source connector refs cannot be enumerated", async () => {
    S.connectorKeysError = true;
    const { req, res } = makeReqRes(baseBody);
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.payload as { error: { code: string } }).error.code).toBe("source_refs_enumeration_failed");
  });

  it("a clean body with connector refs enumerated still passes when no ref appears", async () => {
    S.connectorKeyRows = [{ connector_object_keys: ["slack_channel:C0FUR-ops"] }];
    generalizeCalls.length = 0;
    const { req, res } = makeReqRes(baseBody);
    await staffGlobalRulesPropose(req, res);
    expect(res.statusCode).toBe(200);
    const lastCall = generalizeCalls[generalizeCalls.length - 1];
    const ids = lastCall[1] as { source_refs?: string[] };
    expect(ids.source_refs).toContain("slack_channel:C0FUR-ops");
  });
});
