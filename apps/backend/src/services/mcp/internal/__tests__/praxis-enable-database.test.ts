import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: "pending", error: null };

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));

import { callPraxisTool, listPraxisTools } from "../praxis";

const ctx = { tenant_id: "t-1", run_id: "r-1", agent_slug: "engineer" } as never;

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: "pending", error: null };
});

describe("praxis__enable_database", () => {
  it("is registered as a flat object schema with an optional reason", () => {
    const tool = listPraxisTools().find((t) => t.tool_name === "enable_database");
    expect(tool).toBeTruthy();
    expect(tool!.input_schema.type).toBe("object");
    const props = (tool!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(["reason"]);
    expect((tool!.input_schema as { required?: string[] }).required ?? []).not.toContain("reason");
  });

  it("records the need for ctx.tenant_id via request_app_database", async () => {
    const r = await callPraxisTool(ctx, "enable_database", { reason: "user accounts" });
    expect(r.ok).toBe(true);
    expect(rpcCalls).toEqual([{ fn: "request_app_database", args: { p_tenant_id: "t-1" } }]);
    const body = JSON.parse(r.content as string);
    expect(body).toMatchObject({ recorded: true, status: "pending" });
  });

  it("takes the tenant from ctx, never from args", async () => {
    await callPraxisTool(ctx, "enable_database", { tenant_id: "t-evil", p_tenant_id: "t-evil" });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toEqual({ p_tenant_id: "t-1" });
  });

  it("works with no args", async () => {
    const r = await callPraxisTool(ctx, "enable_database", undefined);
    expect(r.ok).toBe(true);
    expect(rpcCalls[0].args).toEqual({ p_tenant_id: "t-1" });
  });

  it("calling twice is safe (returns the existing row's status)", async () => {
    const first = await callPraxisTool(ctx, "enable_database", {});
    rpcResult = { data: "ready", error: null };
    const second = await callPraxisTool(ctx, "enable_database", {});
    expect(first.ok && second.ok).toBe(true);
    expect(JSON.parse(second.content as string).status).toBe("ready");
    expect(rpcCalls).toHaveLength(2);
  });

  it("an RPC error surfaces as a tool error", async () => {
    rpcResult = { data: null, error: { message: "permission denied" } };
    const r = await callPraxisTool(ctx, "enable_database", {});
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
    const body = JSON.parse(r.content as string);
    expect(body.error).toBe("enable_database_failed");
    expect(body.message).toContain("permission denied");
  });

  it("an over-long reason is rejected before any RPC", async () => {
    const r = await callPraxisTool(ctx, "enable_database", { reason: "x".repeat(500) });
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content as string).error).toBe("input_invalid");
    expect(rpcCalls).toHaveLength(0);
  });
});
