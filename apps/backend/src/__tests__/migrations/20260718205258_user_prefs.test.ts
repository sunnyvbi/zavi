import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260718205258_user_prefs.sql"),
  "utf-8",
);

function fnBody(name: string): string {
  const m = sql.match(new RegExp(`create or replace function ${name}[\\s\\S]*?\\$\\$;`, "i"));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
}

const FNS = ["get_user_prefs", "set_user_pref"];

describe("20260718205258_user_prefs.sql", () => {
  it("both RPCs are security-definer with a pg_temp-pinned search_path", () => {
    for (const f of FNS) {
      const b = fnBody(f);
      expect(b, `${f} must be security definer`).toMatch(/security definer/i);
      expect(b, `${f} must pin pg_temp`).toMatch(/set search_path = public, pg_temp/i);
    }
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\b[\s\S]*?\$\$/gi)) {
      const header = m[0];
      if (!/security\s+definer/i.test(header)) continue;
      expect(header).toMatch(/pg_temp/i);
    }
  });

  it("table is composite-keyed (user_id, tenant_id) — prefs are PER-TENANT", () => {
    expect(sql).toMatch(/create table user_prefs/i);
    expect(sql).toMatch(/primary key \(user_id, tenant_id\)/i);
    expect(sql).toMatch(/references auth\.users\(id\) on delete cascade/i);
    expect(sql).toMatch(/references tenants\(id\) on delete cascade/i);
  });

  it("RLS is on with EXACTLY ONE policy, and it is select-only", () => {
    expect(sql).toMatch(/alter table user_prefs enable row level security/i);
    const policies = sql.match(/create policy/gi) || [];
    expect(policies.length, "exactly one policy").toBe(1);
    expect(sql).toMatch(/create policy user_prefs_self_select on user_prefs\s+for select using \(user_id = auth\.uid\(\)\)/i);
  });

  it("has NO insert/update/delete policy — writes go through the RPC only", () => {
    expect(sql).not.toMatch(/create policy[\s\S]*?for\s+(insert|update|delete|all)\b/i);
  });

  it("both RPCs guard auth + active tenant + membership INSIDE the definer", () => {
    for (const f of FNS) {
      const b = fnBody(f);
      expect(b).toMatch(/raise exception 'not authenticated' using errcode = '42501'/i);
      expect(b).toMatch(/select app_active_tenant\(\) into v_tenant_id/i);
      expect(b).toMatch(/raise exception 'no active tenant' using errcode = '42501'/i);
      expect(b, `${f} must membership-check inside the definer`).toMatch(
        /if not exists \(\s*select 1 from tenant_users\s+where user_id = v_user_id and tenant_id = v_tenant_id\s*\) then\s+raise exception[\s\S]*?'42501'/i,
      );
    }
  });

  it("get_user_prefs returns '{}' when no row exists", () => {
    expect(fnBody("get_user_prefs")).toMatch(/return coalesce\(v_prefs, '\{\}'::jsonb\)/i);
  });

  it("set_user_pref rejects any key outside the server-side allowlist", () => {
    const b = fnBody("set_user_pref");
    expect(b).toMatch(/p_key not in \('viewMode', 'paneWidthPct'\)/);
    expect(b).toMatch(/raise exception 'unknown pref key[\s\S]*?'22023'/i);
  });

  it("set_user_pref validates viewMode as an enum-of-two jsonb string", () => {
    const b = fnBody("set_user_pref");
    expect(b).toMatch(/jsonb_typeof\(p_value\) <> 'string'/i);
    expect(b).toMatch(/\(p_value #>> '\{\}'\) not in \('chat', 'threaded'\)/);
  });

  it("set_user_pref validates paneWidthPct as a number in 20..80 PERCENT via #>>'{}'", () => {
    const b = fnBody("set_user_pref");
    expect(b).toMatch(/jsonb_typeof\(p_value\) <> 'number'/i);
    expect(b).toMatch(/\(p_value #>> '\{\}'\)::numeric/);
    expect(b).not.toMatch(/[^>']\bp_value::numeric/);
    expect(b).toMatch(/v_num < 20 or v_num > 80/i);
  });

  it("the upsert MERGES the jsonb (||) — setting one key must not wipe the other", () => {
    const b = fnBody("set_user_pref");
    expect(b).toMatch(/on conflict \(user_id, tenant_id\) do update/i);
    expect(b).toMatch(/set prefs = user_prefs\.prefs \|\| excluded\.prefs/i);
    expect(b).not.toMatch(/set prefs = excluded\.prefs/i);
    expect(b).toMatch(/updated_at = now\(\)/i);
  });

  it("both RPCs revoke from public and grant only to authenticated", () => {
    expect(sql).toMatch(/revoke all on function get_user_prefs\(\) from public;/i);
    expect(sql).toMatch(/grant execute on function get_user_prefs\(\) to authenticated;/i);
    expect(sql).toMatch(/revoke all on function set_user_pref\(text, jsonb\) from public;/i);
    expect(sql).toMatch(/grant execute on function set_user_pref\(text, jsonb\) to authenticated;/i);
    expect((sql.match(/revoke all on function/gi) || []).length).toBe(2);
    expect(sql).not.toMatch(/grant execute on function[\s\S]*? to (public|anon)\b/i);
  });
});
