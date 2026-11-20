
import { describe, it, expect } from "vitest";
import { scopeToTenant, tenantRealtimeFilter } from "./tenantScope";

function recorder() {
  const calls: Array<[string, unknown[]]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return { proxy, calls };
}

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("scopeToTenant (cross-tenant leak guard)", () => {
  it("applies the tenant_id row filter", () => {
    const { proxy, calls } = recorder();
    scopeToTenant(proxy, TID);
    expect(calls).toContainEqual(["eq", ["tenant_id", TID]]);
  });

  it("returns the same builder so the caller keeps chaining", () => {
    const { proxy } = recorder();
    const out = scopeToTenant(proxy, TID);
    expect(out).toBe(proxy);
  });

  it("scopes a memory_note read before its other filters", () => {
    const { proxy, calls } = recorder();
    scopeToTenant(proxy.from("memory_note").select("id"), TID)
      .neq("note_type", "anchor")
      .order("updated_at", { ascending: false })
      .limit(200);
    const names = calls.map((c) => c[0]);
    expect(names).toContain("eq");
    expect(calls).toContainEqual(["eq", ["tenant_id", TID]]);
    expect(names.indexOf("eq")).toBeLessThan(names.indexOf("neq"));
  });
});

describe("tenantRealtimeFilter (realtime isolation boundary)", () => {
  it("produces the server-side postgres_changes filter string", () => {
    expect(tenantRealtimeFilter(TID)).toBe(`tenant_id=eq.${TID}`);
  });
});
