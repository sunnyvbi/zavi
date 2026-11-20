import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260627111500_clear_tenant_autonomy.sql",
  ),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const clearBody = (() => {
  const start = ddl.toLowerCase().indexOf("function clear_tenant_autonomy");
  expect(start).toBeGreaterThan(-1);
  const rest = ddl.slice(start);
  const end = rest.indexOf("$$;");
  return rest.slice(0, end === -1 ? undefined : end).toLowerCase();
})();

describe("20260627111500_clear_tenant_autonomy.sql", () => {
  it("makes autonomy nullable", () => {
    expect(ddl).toMatch(
      /alter table tenant_decision_class_overrides\s+alter column autonomy drop not null/i,
    );
  });

  it("creates clear_tenant_autonomy as a member-gated security-definer RPC", () => {
    expect(ddl).toMatch(
      /create or replace function clear_tenant_autonomy\(\s*p_tenant_id uuid,\s*p_decision_class text/i,
    );
    expect(clearBody).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(clearBody).toContain("from tenant_users");
    expect(clearBody).toContain("not a member of tenant");
  });

  it("clears autonomy + the coupled active-waiver fields", () => {
    expect(clearBody).toMatch(/set\s+autonomy\s+=\s+null/i);
    expect(clearBody).toMatch(/waiver_expires_at\s+=\s+null/i);
    expect(clearBody).toMatch(/waiver_max_daily_usd\s+=\s+null/i);
    expect(clearBody).toMatch(/waiver_cooling_off_seconds\s+=\s+0/i);
  });

  it("PRESERVES the passive ceilings (does not touch caps / money_model)", () => {
    expect(clearBody).not.toMatch(/\bmax_daily_usd/);
    expect(clearBody).not.toContain("max_per_action_usd");
    expect(clearBody).not.toContain("money_model");
  });

  it("hardens set_tenant_autonomy to reject a null p_autonomy", () => {
    expect(ddl).toMatch(/if p_autonomy is null then/i);
    expect(ddl).toMatch(/use clear_tenant_autonomy to inherit/i);
  });

  it("grants execute to authenticated only", () => {
    expect(ddl).toMatch(/revoke all on function clear_tenant_autonomy\(uuid, text\) from public/i);
    expect(ddl).toMatch(/grant execute on function clear_tenant_autonomy\(uuid, text\) to authenticated/i);
  });
});
