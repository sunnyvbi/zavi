
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const H = vi.hoisted(() => ({
  eqCalls: [] as { table: string; col: string; val: unknown }[],
  insertedRows: [] as { table: string; row: Record<string, unknown> }[],
  updatedRows: [] as { table: string; patch: Record<string, unknown>; eqs: Record<string, unknown> }[],
  inngestSends: [] as unknown[],
  tenantExists: true,
  bakeHandler: "praxis.bake_rule" as string | null,
  disabledSlugs: new Set<string>(),
  existingDecisions: [] as Record<string, unknown>[],
  inngestThrows: false,
  feedbackRows: [] as { id: string; tenant_id: string; agent_slug?: string }[],
}));

function makeChain(table: string) {
  let tenantFilter: string | null = null;
  const eqs: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  chain.select = ret;
  chain.gte = ret;
  chain.order = ret;
  chain.limit = () => resolveList();
  chain.eq = (col: string, val: unknown) => {
    H.eqCalls.push({ table, col, val });
    eqs[col] = val;
    if (col === "tenant_id") tenantFilter = String(val);
    return chain;
  };
  chain.maybeSingle = () => {
    if (table === "tenants") {
      return Promise.resolve({ data: H.tenantExists ? { id: tenantFilter } : null, error: null });
    }
    if (table === "decision_classes") {
      return Promise.resolve({
        data: H.bakeHandler === null ? null : { slug: "proposed_rule", dispatch_handler: H.bakeHandler },
        error: null,
      });
    }
    if (table === "agent_feedback") {
      const match = H.feedbackRows.find(
        (f) =>
          f.id === eqs.id &&
          f.tenant_id === eqs.tenant_id &&
          (eqs.agent_slug === undefined || f.agent_slug === undefined || f.agent_slug === eqs.agent_slug),
      );
      return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  chain.insert = (row: Record<string, unknown>) => {
    H.insertedRows.push({ table, row });
    return {
      select: () => ({
        single: () => Promise.resolve({ data: { id: "decision-new" }, error: null }),
      }),
    };
  };
  chain.update = (patch: Record<string, unknown>) => {
    const upEqs: Record<string, unknown> = {};
    const up: Record<string, unknown> = {};
    up.eq = (col: string, val: unknown) => {
      upEqs[col] = val;
      if (col === "tenant_id") {
        H.updatedRows.push({ table, patch, eqs: { ...upEqs } });
      }
      return up;
    };
    return up;
  };
  function resolveList() {
    if (table === "decisions") {
      const rows = H.existingDecisions.filter((d) => d.tenant_id === tenantFilter);
      return Promise.resolve({ data: rows, error: null });
    }
    return Promise.resolve({ data: [], error: null });
  }
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: vi.fn((t: string) => makeChain(t)) })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "staff-1", email: "ravi@zaviagent.com" })),
}));
vi.mock("@/services/agents/registry", () => ({
  loadGlobalAgentDefinition: vi.fn((slug: string) => (slug === "ghost" ? null : { slug })),
}));
vi.mock("@/services/agents/visibility", () => ({
  getTenantDisabledSlugs: vi.fn(async () => H.disabledSlugs),
}));
vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn(async (e: unknown) => {
      if (H.inngestThrows) throw new Error("inngest down");
      H.inngestSends.push(e);
      return { ids: ["x"] };
    }),
  },
}));
vi.mock("@/services/staff/audit", () => ({
  writeStaffAudit: vi.fn(async () => undefined),
}));

import { staffTenantAgentBake } from "../../routes/admin/agent-bake";

function mockReq(tenantId: string, slug: string, body: unknown): Request {
  return { params: { tenant_id: tenantId, slug }, body } as unknown as Request;
}
function mockRes() {
  const r: Partial<Response> & { _status: number; _json: any } = {
    _status: 200,
    _json: null,
    status(code: number) {
      this._status = code;
      return this as Response;
    },
    json(b: unknown) {
      this._json = b;
      return this as Response;
    },
  };
  return r as Response & { _status: number; _json: any };
}

beforeEach(() => {
  H.eqCalls.length = 0;
  H.insertedRows.length = 0;
  H.updatedRows.length = 0;
  H.inngestSends.length = 0;
  H.tenantExists = true;
  H.bakeHandler = "praxis.bake_rule";
  H.disabledSlugs = new Set<string>();
  H.existingDecisions = [];
  H.inngestThrows = false;
  H.feedbackRows = [];
});

describe("staffTenantAgentBake", () => {
  it("bakes a single-tenant decision keyed to the URL tenant_id (never another tenant)", async () => {
    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "Always confirm before money." }), res);

    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.decision_id).toBe("decision-new");

    const ins = H.insertedRows.filter((r) => r.table === "decisions");
    expect(ins).toHaveLength(1);
    expect(ins[0].row.tenant_id).toBe(TENANT_A);
    expect(ins[0].row.status).toBe("approved");
    expect(ins[0].row.handler).toBe("praxis.bake_rule");
    expect((ins[0].row.body as any).target_agent_slug).toBe("engineer");
    expect((ins[0].row.body as any).origin).toBe("per_tenant_staff_bake");

    expect(H.eqCalls.some((c) => c.val === TENANT_B)).toBe(false);
    const decisionLookups = H.eqCalls.filter((c) => c.table === "decisions" && c.col === "tenant_id");
    expect(decisionLookups.every((c) => c.val === TENANT_A)).toBe(true);

    expect(H.inngestSends).toHaveLength(1);
  });

  it("is idempotent — a recent matching bake returns the existing decision, no second insert", async () => {
    const first = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "Cap answers at 4 bullets." }), first);
    const baked = H.insertedRows.find((r) => r.table === "decisions")!.row;
    H.existingDecisions = [
      { id: "decision-prev", tenant_id: TENANT_A, status: "approved", body: baked.body, source_feedback_id: null, emitted_at: new Date().toISOString() },
    ];
    H.insertedRows.length = 0;
    H.inngestSends.length = 0;

    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "Cap answers at 4 bullets." }), res);
    expect(res._status).toBe(200);
    expect(res._json.idempotent).toBe(true);
    expect(res._json.decision_id).toBe("decision-prev");
    expect(H.insertedRows.filter((r) => r.table === "decisions")).toHaveLength(0);
    expect(H.inngestSends).toHaveLength(0);
  });

  it("refuses a disabled/kill-switched agent unless override_disabled", async () => {
    H.disabledSlugs = new Set(["engineer"]);
    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse." }), res);
    expect(res._status).toBe(409);
    expect(res._json.error.code).toBe("agent_disabled");
    expect(H.insertedRows.filter((r) => r.table === "decisions")).toHaveLength(0);

    const res2 = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse.", override_disabled: true }), res2);
    expect(res2._status).toBe(200);
    expect(res2._json.ok).toBe(true);
  });

  it("404s on a missing tenant and on a non-existent agent", async () => {
    H.tenantExists = false;
    const r1 = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "x rule." }), r1);
    expect(r1._status).toBe(404);
    expect(r1._json.error.code).toBe("tenant_not_found");

    H.tenantExists = true;
    const r2 = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "ghost", { rule_body_markdown: "x rule." }), r2);
    expect(r2._status).toBe(404);
    expect(r2._json.error.code).toBe("agent_not_found");
  });

  it("fails closed if the bake decision-class config drifted off praxis.bake_rule", async () => {
    H.bakeHandler = "something.else";
    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "x rule." }), res);
    expect(res._status).toBe(500);
    expect(res._json.error.code).toBe("bake_misconfigured");
    expect(H.insertedRows.filter((r) => r.table === "decisions")).toHaveLength(0);
  });

  it("reverts (rejects) the decision and fails the request if inngest.send throws", async () => {
    H.inngestThrows = true;
    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "x rule." }), res);
    expect(res._status).toBe(502);
    expect(res._json.error.code).toBe("dispatch_send_failed");
    const revert = H.updatedRows.find((u) => u.table === "decisions");
    expect(revert).toBeTruthy();
    expect(revert!.patch.status).toBe("rejected");
    expect(revert!.eqs.tenant_id).toBe(TENANT_A);
  });

  it("rejects a source_feedback_id that belongs to ANOTHER tenant (cross-tenant guard)", async () => {
    const F1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    H.feedbackRows = [{ id: F1, tenant_id: TENANT_B }];
    const res = mockRes();
    await staffTenantAgentBake(
      mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse.", source_feedback_id: F1 }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json.error.code).toBe("source_feedback_not_found");
    expect(H.insertedRows.filter((r) => r.table === "decisions")).toHaveLength(0);

    H.feedbackRows = [{ id: F1, tenant_id: TENANT_A }];
    const res2 = mockRes();
    await staffTenantAgentBake(
      mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse.", source_feedback_id: F1 }),
      res2,
    );
    expect(res2._status).toBe(200);
    expect(res2._json.ok).toBe(true);
    expect(H.insertedRows.find((r) => r.table === "decisions")!.row.source_feedback_id).toBe(F1);
  });

  it("rejects a source_feedback_id that belongs to a DIFFERENT agent in the SAME tenant (3b agent_slug guard)", async () => {
    const F2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    H.feedbackRows = [{ id: F2, tenant_id: TENANT_A, agent_slug: "pm" }];
    const res = mockRes();
    await staffTenantAgentBake(
      mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse.", source_feedback_id: F2 }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json.error.code).toBe("source_feedback_not_found");
    expect(H.insertedRows.filter((r) => r.table === "decisions")).toHaveLength(0);

    H.feedbackRows = [{ id: F2, tenant_id: TENANT_A, agent_slug: "engineer" }];
    const res2 = mockRes();
    await staffTenantAgentBake(
      mockReq(TENANT_A, "engineer", { rule_body_markdown: "Be terse.", source_feedback_id: F2 }),
      res2,
    );
    expect(res2._status).toBe(200);
    expect(res2._json.ok).toBe(true);
  });

  it("rejects an empty/too-short rule body", async () => {
    const res = mockRes();
    await staffTenantAgentBake(mockReq(TENANT_A, "engineer", { rule_body_markdown: "x" }), res);
    expect(res._status).toBe(400);
    expect(res._json.error.code).toBe("invalid_body");
  });
});
