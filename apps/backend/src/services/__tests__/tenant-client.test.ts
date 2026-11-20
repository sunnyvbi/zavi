import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
function builder() {
  const b: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "in", "or", "order", "single"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  return b;
}
const fromSpy = vi.fn((_table: string) => builder());
const rpcSpy = vi.fn((_name: string, _args: unknown) => ({}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromSpy, rpc: rpcSpy }),
}));

import {
  tenantClient,
  globalClient,
  staffCrossTenantClient,
  tenantRpc,
  asTenantId,
  __testing,
  type TenantId,
} from "@/services/tenant-client";

const TID = asTenantId("tenant-A");
const OTHER = "tenant-B";

beforeEach(() => {
  calls.length = 0;
  fromSpy.mockClear();
  rpcSpy.mockClear();
  __testing.registerForTest("t_tenant", "tenant_id");
  __testing.registerForTest("t_global", "global");
  __testing.registerForTest("t_user", "user_id");
  __testing.registerForTest("t_idtenant", "idIsTenantId");
});
afterEach(() => {
  for (const t of ["t_tenant", "t_global", "t_user", "t_idtenant"]) __testing.unregisterForTest(t);
});

describe("tenantClient facade — scoping", () => {
  it("select auto-applies .eq(tenant_id, tid) and forwards count/head opts", () => {
    tenantClient(TID).from("t_tenant").select("id,name", { count: "exact", head: true });
    const sel = calls.find((c) => c.method === "select")!;
    expect(sel.args).toEqual(["id,name", { count: "exact", head: true }]);
    const eq = calls.find((c) => c.method === "eq")!;
    expect(eq.args).toEqual(["tenant_id", "tenant-A"]);
  });

  it("further chaining (.in/.or) still works on the returned builder", () => {
    const q = tenantClient(TID).from("t_tenant").select("*") as any;
    q.in("status", ["done"]).or("trigger.eq.chat");
    expect(calls.some((c) => c.method === "in")).toBe(true);
    expect(calls.some((c) => c.method === "or")).toBe(true);
  });

  it("insert stamps tenant_id (array-safe)", () => {
    tenantClient(TID).from("t_tenant").insert([{ a: 1 }, { a: 2 }]);
    const ins = calls.find((c) => c.method === "insert")!;
    expect(ins.args[0]).toEqual([{ a: 1, tenant_id: "tenant-A" }, { a: 2, tenant_id: "tenant-A" }]);
  });

  it("insert THROWS on a conflicting tenant_id (cross-tenant write attempt)", () => {
    expect(() => tenantClient(TID).from("t_tenant").insert({ tenant_id: OTHER, a: 1 })).toThrow(/differs from the client scope/);
  });

  it("update applies .eq and refuses a conflicting scope value", () => {
    tenantClient(TID).from("t_tenant").update({ a: 9 });
    expect(calls.find((c) => c.method === "eq")!.args).toEqual(["tenant_id", "tenant-A"]);
    expect(() => tenantClient(TID).from("t_tenant").update({ tenant_id: OTHER })).toThrow();
  });

  it("delete applies .eq(tenant_id, tid)", () => {
    tenantClient(TID).from("t_tenant").delete();
    expect(calls.find((c) => c.method === "eq")!.args).toEqual(["tenant_id", "tenant-A"]);
  });
});

describe("tenantClient facade — upsert onConflict safety", () => {
  it("REJECTS an upsert whose onConflict omits the scope column", () => {
    expect(() => tenantClient(TID).from("t_tenant").upsert({ a: 1 }, { onConflict: "run_id" })).toThrow(/requires onConflict to include 'tenant_id'/);
  });
  it("allows an upsert whose onConflict includes the scope column", () => {
    tenantClient(TID).from("t_tenant").upsert({ a: 1 }, { onConflict: "tenant_id,run_id" });
    const up = calls.find((c) => c.method === "upsert")!;
    expect(up.args[0]).toEqual([{ a: 1, tenant_id: "tenant-A" }]);
  });
});

describe("tenantClient facade — registry gating", () => {
  it("throws with a helpful message on a global table", () => {
    expect(() => tenantClient(TID).from("t_global")).toThrow(/globalClient/);
  });
  it("throws on a user-scoped table", () => {
    expect(() => tenantClient(TID).from("t_user")).toThrow(/user-scoped/);
  });
  it("throws fail-closed on an unclassified table", () => {
    expect(() => tenantClient(TID).from("t_unknown_xyz")).toThrow(/not classified/);
  });
  it("idIsTenantId table scopes by id and refuses inserts", () => {
    tenantClient(TID).from("t_idtenant").select("*");
    expect(calls.find((c) => c.method === "eq")!.args).toEqual(["id", "tenant-A"]);
    expect(() => tenantClient(TID).from("t_idtenant").insert({ a: 1 })).toThrow(/not a tenant-scoped operation/);
  });
});

describe("tenantClient facade — embedded selects", () => {
  it("allows attempts only through their tenant-filtered social post parent", () => {
    tenantClient(TID).from("social_posts").select("id, social_publish_attempts(response)");
    expect(calls).toContainEqual({ method: "eq", args: ["tenant_id", "tenant-A"] });
    expect(() => tenantClient(TID).from("social_posts").select("id, unrelated(response)")).toThrow(/embedded select/);
    expect(() => tenantClient(TID).from("social_posts").select("social_publish_attempts(response),unrelated(secret)")).toThrow(/embedded select/);
    expect(() => tenantClient(TID).from("social_posts").select("social_publish_attempts(unrelated(secret))")).toThrow(/embedded select/);
    expect(() => tenantClient(TID).from("social_publish_attempts").select("response")).toThrow();
  });
  it("denies an embedded/joined select unless the relation is registered", () => {
    expect(() => tenantClient(TID).from("t_tenant").select("id, children(x)")).toThrow(/embedded select/);
  });
  it("allows an embedded select once the relation is registered safe", () => {
    __testing.registerSafeEmbedForTest("t_tenant.children");
    expect(() => tenantClient(TID).from("t_tenant").select("id, children(x)")).not.toThrow();
  });
});

describe("named escapes", () => {
  it("globalClient allows a global table and rejects a non-global one", () => {
    expect(() => globalClient().from("t_global")).not.toThrow();
    expect(() => globalClient().from("t_tenant")).toThrow(/not a global table/);
  });
  it("staffCrossTenantClient requires a substantive reason", () => {
    expect(() => staffCrossTenantClient("x")).toThrow(/reason/);
    expect(() => staffCrossTenantClient("nightly cross-tenant staff audit")).not.toThrow();
  });
});

describe("tenantRpc", () => {
  it("injects the tenant arg for a registered RPC", () => {
    tenantRpc(TID, "mint_oauth_state", { p_provider: "meta_ads" });
    expect(rpcSpy).toHaveBeenCalledWith("mint_oauth_state", { p_provider: "meta_ads", p_tenant_id: "tenant-A" });
  });
  it("throws on an unregistered RPC (fail-closed)", () => {
    expect(() => tenantRpc(TID, "some_unknown_rpc")).toThrow(/not in the tenant-RPC registry/);
  });
  it("throws if caller passed a conflicting tenant arg", () => {
    expect(() => tenantRpc(TID, "mint_oauth_state", { p_tenant_id: OTHER })).toThrow(/!= scope/);
  });
});

describe("TenantId brand", () => {
  it("asTenantId produces a value usable as a string", () => {
    const t: TenantId = asTenantId("abc");
    const s: string = t;
    expect(s).toBe("abc");
  });
});
