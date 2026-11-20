import { describe, it, expect } from "vitest";
import { authorTenantRoutine, approveTenantRoutine } from "../tenant-authoring";

function mockSb(opts: {
  insertResult?: { data: unknown; error: unknown };
  loadResult?: { data: unknown; error: unknown };
  onInsert?: (payload: Record<string, unknown>) => void;
}) {
  const q: Record<string, unknown> = {};
  const chain: any = {
    _table: "",
    from(t: string) { chain._table = t; return chain; },
    insert(payload: Record<string, unknown>) { q.payload = payload; opts.onInsert?.(payload); chain._op = "insert"; return chain; },
    select() { return chain; },
    update(payload: Record<string, unknown>) { q.update = payload; chain._op = "update"; return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    async maybeSingle() {
      if (chain._op === "insert") return opts.insertResult ?? { data: { id: "new-id" }, error: null };
      return opts.loadResult ?? { data: null, error: null };
    },
  };
  return chain;
}

const GOOD_SPEC = { type: "tool_sequence", steps: [{ tool: "slack__post_message", args: {} }] };

const okResolver = async () => [
  { name: "slack__post_message", input_schema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } }, additionalProperties: true } },
];

describe("authorTenantRoutine", () => {
  it("rejects a freeform (non-tool_sequence) spec", async () => {
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "x", routine_spec: "do stuff", granted_tool_names: ["slack__post_message"], created_by: "u1" },
      mockSb({}),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_routine_spec/);
  });

  it("rejects an empty granted_tool_names", async () => {
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "x", routine_spec: GOOD_SPEC, granted_tool_names: [], created_by: "u1" },
      mockSb({}),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/granted_tool_names/);
  });

  it("requires routine_name", async () => {
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "   ", routine_spec: GOOD_SPEC, granted_tool_names: ["slack__post_message"], created_by: "u1" },
      mockSb({}),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/routine_name/);
  });

  it("inserts a candidate row with tenant_authored provenance + founder_blessed=false", async () => {
    let captured: Record<string, unknown> | undefined;
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "Payout SOP", routine_spec: GOOD_SPEC, granted_tool_names: ["slack__post_message"], created_by: "u1" },
      mockSb({ onInsert: (p) => { captured = p; } }),
      okResolver,
    );
    expect(r.ok).toBe(true);
    expect(r.id).toBe("new-id");
    expect(captured).toMatchObject({
      tenant_id: "t1",
      agent_slug: "operator",
      status: "candidate",
      provenance_origin: "tenant_authored",
      founder_blessed: false,
      created_by: "u1",
      spec_version: 1,
    });
    expect(captured).not.toHaveProperty("max_cents");
  });

  it("rejects a step missing a required arg (validated vs live schema)", async () => {
    const requireText = async () => [
      { name: "slack__post_message", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    ];
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "x", routine_spec: GOOD_SPEC, granted_tool_names: ["slack__post_message"], created_by: "u1" },
      mockSb({}),
      requireText,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_step_args.*missing required arg 'text'/);
  });

  it("fails closed when the step's tool is not among the agent's live tools", async () => {
    const noTools = async () => [];
    const r = await authorTenantRoutine(
      { tenant_id: "t1", agent_slug: "operator", routine_name: "x", routine_spec: GOOD_SPEC, granted_tool_names: ["slack__post_message"], created_by: "u1" },
      mockSb({}),
      noTools,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_step_args.*not among the agent's live tools/);
  });
});

describe("approveTenantRoutine guards", () => {
  it("refuses a routine not found for this tenant (cross-tenant / missing)", async () => {
    const r = await approveTenantRoutine("id1", "t1", "u1", mockSb({ loadResult: { data: null, error: null } }));
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it("refuses a machine-distilled routine (wrong route)", async () => {
    const r = await approveTenantRoutine(
      "id1", "t1", "u1",
      mockSb({ loadResult: { data: { id: "id1", tenant_id: "t1", status: "candidate", provenance_origin: "machine_distilled" }, error: null } }),
    );
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/not_tenant_authored/);
  });
});
