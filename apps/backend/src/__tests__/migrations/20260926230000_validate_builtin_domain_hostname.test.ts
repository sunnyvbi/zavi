import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_HOST_LABELS, RESERVED_LABELS } from "../../services/provisioning/builtin-url";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260926230000_validate_builtin_domain_hostname.sql"),
  "utf-8",
);

describe("set_tenant_builtin_domain hostname validation (20260926230000)", () => {
  it("reserves exactly the labels builtin-url.ts reserves", () => {
    const list = SQL.slice(SQL.indexOf("= any (array["), SQL.indexOf("])", SQL.indexOf("= any (array[")));
    const sqlLabels = new Set([...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
    expect([...sqlLabels].sort()).toEqual([...RESERVED_LABELS].filter((l) => !PLATFORM_HOST_LABELS.includes(l)).sort());
  });

  it("validates before the write and keeps the owner|admin check and grants", () => {
    const check = SQL.indexOf("invalid built-in hostname");
    expect(check).toBeGreaterThan(SQL.indexOf("caller is not owner|admin"));
    expect(check).toBeLessThan(SQL.indexOf("insert into tenant_resources"));
    expect(SQL).toMatch(/like '%\.zaviagent\.com'/);
    expect(SQL).toMatch(/revoke all on function set_tenant_builtin_domain\(uuid, jsonb, text\) from public, anon, authenticated;/);
  });
});
