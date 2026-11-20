import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_TENANT_EMAIL_DOMAINS } from "@/services/tenants/classify-test-tenant";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261026110000_tenant_kind_at_creation.sql";
const SQL = readFileSync(join(DIR, FILE), "utf-8");
const V2_PRIOR = readFileSync(join(DIR, "20260517235000_activate_tenant_v2_tiered_anchors.sql"), "utf-8");
const LITE_PRIOR = readFileSync(
  join(DIR, "20260701170000_harden_tenant_kind_downgrade_and_tag_capability.sql"),
  "utf-8",
);

const stripComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const CODE = stripComments(SQL);
const PG_TEMP = "set search_path = public, pg_temp as";
const NO_PG_TEMP = "set search_path = public as";

function fnOf(source: string, name: string): string {
  const code = stripComments(source);
  const start = code.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = code.indexOf("end $$;", start);
  expect(end, `${name} is closed`).toBeGreaterThan(start);
  return norm(code.slice(start, end + "end $$;".length));
}

describe("20261026110000 — tenants.kind decided at creation", () => {
  it("is_test_tenant_email lists exactly the TS TEST_TENANT_EMAIL_DOMAINS (parity)", () => {
    const m = CODE.match(/function is_test_tenant_email\(p_email text\)[\s\S]*?= any \(array\[([\s\S]*?)\]\)/);
    expect(m, "is_test_tenant_email array literal").not.toBeNull();
    const sqlDomains = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(sqlDomains).toEqual([...TEST_TENANT_EMAIL_DOMAINS].sort());
  });

  it("is_test_tenant_email matches the domain after the LAST @ (same rule as the TS helper)", () => {
    expect(CODE).toContain("substring(p_email from '[^@]*$')");
    expect(CODE).toContain("lower(trim(");
  });

  it("tenant_kind_for_owner reads auth.users as security definer, defaults to 'real', and is not public", () => {
    const fn = CODE.slice(CODE.indexOf("function tenant_kind_for_owner"), CODE.indexOf("revoke all on function tenant_kind_for_owner"));
    expect(fn).toContain("security definer set search_path = public");
    expect(fn).toContain("from auth.users u");
    expect(norm(fn)).toContain("then 'test' else 'real' end");
    expect(norm(fn)).toMatch(/coalesce\( \(select .*\), 'real' \)/);
    expect(CODE).toContain("revoke all on function tenant_kind_for_owner(uuid) from public, anon, authenticated;");
    expect(CODE).not.toMatch(/grant execute on function tenant_kind_for_owner/);
  });

  it("activate_tenant_v2: same signature (no client-controllable kind), insert derives kind from auth.uid()", () => {
    const v2 = fnOf(SQL, "activate_tenant_v2");
    expect(v2).toContain(
      "create or replace function activate_tenant_v2( p_slug text, p_display_name text, p_rar numeric, p_memory jsonb, p_primary_anchors jsonb default '[]'::jsonb ) returns uuid",
    );
    expect(v2).not.toContain("p_kind");
    expect(v2).toContain(
      "insert into tenants (slug, display_name, rar_weekly_threshold, kind) values (p_slug, p_display_name, p_rar, tenant_kind_for_owner(v_caller))",
    );
    expect(CODE).toContain("revoke all on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) from public, anon, authenticated;");
    expect(CODE.match(/grant execute on function activate_tenant_v2[^;]*;/g)).toEqual([
      "grant execute on function activate_tenant_v2(text, text, numeric, jsonb, jsonb) to authenticated, service_role;",
    ]);
  });

  it("activate_tenant_v2 equals its prior definition except for the kind-at-insert change", () => {
    const rebuilt = fnOf(SQL, "activate_tenant_v2").replace(PG_TEMP, NO_PG_TEMP).replace(
      "insert into tenants (slug, display_name, rar_weekly_threshold, kind) values (p_slug, p_display_name, p_rar, tenant_kind_for_owner(v_caller))",
      "insert into tenants (slug, display_name, rar_weekly_threshold) values (p_slug, p_display_name, p_rar)",
    );
    expect(rebuilt).toBe(fnOf(V2_PRIOR, "activate_tenant_v2"));
  });

  it("activate_tenant_lite: explicit p_kind='test' wins, default resolves via the owner's email", () => {
    const lite = fnOf(SQL, "activate_tenant_lite");
    expect(lite).toContain("p_allow_additional boolean default false, p_kind text default 'real' ) returns uuid");
    expect(lite).toContain(
      "v_kind := case when p_kind = 'test' then 'test' else tenant_kind_for_owner(p_user_id) end;",
    );
    expect(lite).toContain("insert into tenants (slug, display_name, kind) values (p_slug, p_display_name, v_kind)");
    expect(CODE.match(/grant execute on function activate_tenant_lite[^;]*;/g)).toEqual([
      "grant execute on function activate_tenant_lite(uuid, text, text, boolean, text) to service_role;",
    ]);
  });

  it("activate_tenant_lite equals its prior definition except for v_kind", () => {
    const rebuilt = fnOf(SQL, "activate_tenant_lite")
      .replace(PG_TEMP, NO_PG_TEMP)
      .replace(" v_kind text;", "")
      .replace(" v_kind := case when p_kind = 'test' then 'test' else tenant_kind_for_owner(p_user_id) end;", "")
      .replace("values (p_slug, p_display_name, v_kind)", "values (p_slug, p_display_name, p_kind)");
    expect(rebuilt).toBe(fnOf(LITE_PRIOR, "activate_tenant_lite"));
  });

  it("does NOT touch the downgrade guard, the delete guard, or any existing tenants row", () => {
    expect(CODE).not.toMatch(/tenant_kind_downgrade_guard|tenants_kind_downgrade_guard/);
    expect(CODE).not.toMatch(/allow_tenant_kind_downgrade/);
    expect(CODE).not.toMatch(/tenants_delete_guard/);
    expect(CODE).not.toMatch(/update\s+tenants/i);
    expect(CODE).not.toMatch(/drop\s+trigger/i);
  });
});
