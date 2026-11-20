import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260528191600_browser_action_never_auto.sql",
  ),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260528191600_browser_action_never_auto.sql", () => {
  it("redefines effective_autonomy as security definer + correct grants", () => {
    expect(ddl).toMatch(
      /create or replace function effective_autonomy\(\s*p_tenant_id uuid,\s*p_decision_class text/i,
    );
    expect(ddl).toMatch(/language plpgsql security definer set search_path = public stable/i);
    expect(ddl).toMatch(/revoke all on function effective_autonomy\(uuid, text\) from public/i);
    expect(ddl).toMatch(
      /grant execute on function effective_autonomy\(uuid, text\) to authenticated, service_role/i,
    );
  });

  it("effective_autonomy clamps browser.action to 'approval' BEFORE consulting any override", () => {
    expect(ddl).toMatch(
      /if p_decision_class = any \(array\['browser\.action'\]\) then\s*return 'approval'::decision_autonomy;\s*end if;/i,
    );
    const clampIdx = ddl.search(/array\['browser\.action'\]\) then\s*return 'approval'/i);
    const overrideIdx = ddl.search(/from tenant_decision_class_overrides/i);
    expect(clampIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(clampIdx).toBeLessThan(overrideIdx);
  });

  it("set_tenant_autonomy rejects a non-'approval' override on browser.action", () => {
    expect(ddl).toMatch(
      /create or replace function set_tenant_autonomy\(\s*p_tenant_id uuid,\s*p_decision_class text,\s*p_autonomy decision_autonomy/i,
    );
    expect(ddl).toMatch(
      /if p_decision_class = any \(array\['browser\.action'\]\)\s*and p_autonomy <> 'approval'::decision_autonomy then\s*raise exception/i,
    );
  });

  it("set_tenant_autonomy keeps the auth + membership checks (no privilege regression)", () => {
    expect(ddl).toMatch(/if auth\.uid\(\) is null then\s*raise exception 'not authenticated'/i);
    expect(ddl).toMatch(/not a member of tenant/i);
    expect(ddl).toMatch(/revoke all on function set_tenant_autonomy\(uuid, text, decision_autonomy\) from public/i);
    expect(ddl).toMatch(
      /grant execute on function set_tenant_autonomy\(uuid, text, decision_autonomy\) to authenticated/i,
    );
  });

  it("is CREATE OR REPLACE only — no destructive DDL on the autonomy tables", () => {
    expect(ddl).not.toMatch(/drop\s+(table|function|type)\b/i);
    expect(ddl).not.toMatch(/alter\s+table\s+tenant_decision_class_overrides/i);
  });
});
