import { describe, it, expect } from "vitest";
import { filterOutShellTenants } from "./_shell-tenant-filter";

const row = (tenant_id: string, agent_slug = "operator") => ({ tenant_id, agent_slug });

describe("filterOutShellTenants", () => {
  it("returns all rows unchanged when no shell tenants exist", () => {
    const rows = [row("t1"), row("t2")];
    expect(filterOutShellTenants(rows, new Set())).toEqual({ kept: rows, excluded: 0 });
  });

  it("drops rows whose tenant is a shell, keeps the rest", () => {
    const rows = [row("real1"), row("shell1"), row("real2"), row("shell1", "pm")];
    const { kept, excluded } = filterOutShellTenants(rows, new Set(["shell1"]));
    expect(excluded).toBe(2);
    expect(kept.map((r) => r.tenant_id)).toEqual(["real1", "real2"]);
  });

  it("drops everything when all rows belong to shells", () => {
    const rows = [row("s1"), row("s2")];
    const { kept, excluded } = filterOutShellTenants(rows, new Set(["s1", "s2"]));
    expect(kept).toEqual([]);
    expect(excluded).toBe(2);
  });

  it("empty input is a no-op", () => {
    expect(filterOutShellTenants([], new Set(["s1"]))).toEqual({ kept: [], excluded: 0 });
  });
});
