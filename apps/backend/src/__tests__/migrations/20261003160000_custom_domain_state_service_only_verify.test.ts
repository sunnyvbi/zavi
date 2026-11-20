import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261003160000_custom_domain_state_service_only_verify.sql"), "utf-8");
const STATE_ORIGINAL = readFileSync(join(dir, "20260723134455_tenant_custom_domains.sql"), "utf-8");
const ADD_ORIGINAL = readFileSync(join(dir, "20261003151000_validate_custom_domain_rpc.sql"), "utf-8");

const STATE_SIG = "set_tenant_custom_domain_state(uuid, text, text, jsonb, int, timestamptz, text)";
const ADD_SIG = "set_tenant_custom_domain(uuid, text, text, text, text, text, jsonb)";
const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const fnText = (s: string, name: string) => {
  const start = s.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf("end $$;", start) + "end $$;".length);
};
const header = (s: string, name: string) => {
  const f = fnText(s, name);
  return strip(f.slice(0, f.indexOf("as $$")));
};
const ifBlocks = (f: string) => [...f.matchAll(/ {2}if [\s\S]*?\n {2}end if;\n/g)].map((m) => m[0]);

const STATE = fnText(SQL, "set_tenant_custom_domain_state");
const ADD = fnText(SQL, "set_tenant_custom_domain");

describe("set_tenant_custom_domain_state service-only verify (20261003160000)", () => {
  it("replaces the function with the identical signature, definer and search_path", () => {
    expect(header(SQL, "set_tenant_custom_domain_state")).toBe(header(STATE_ORIGINAL, "set_tenant_custom_domain_state"));
    expect(header(SQL, "set_tenant_custom_domain_state")).toMatch(/security definer set search_path = public, pg_temp$/);
  });

  it("refuses verified and verifying for any JWT caller with a clear code", () => {
    expect(STATE).toMatch(
      /if auth\.uid\(\) is not null and p_status in \('verified', 'verifying'\) then\s+raise exception 'set_tenant_custom_domain_state: status % can only be set by verification', p_status\s+using errcode = '42501';/,
    );
  });

  it("refuses a JWT caller changing the stored render_custom_domain_id", () => {
    expect(STATE).toMatch(
      /if auth\.uid\(\) is not null and p_render_custom_domain_id is not null\s+and p_render_custom_domain_id is distinct from \(\s+select d\.render_custom_domain_id from tenant_custom_domains d where d\.id = p_id\s+\) then\s+raise exception 'set_tenant_custom_domain_state: render_custom_domain_id can only be set by the server'\s+using errcode = '42501';/,
    );
  });

  it("keeps the owner|admin gate and checks everything before the update", () => {
    const role = STATE.indexOf("caller is not owner|admin of the domain''s tenant");
    const status = STATE.indexOf("p_status in ('verified', 'verifying')");
    const rcd = STATE.indexOf("render_custom_domain_id can only be set by the server");
    const update = STATE.indexOf("update tenant_custom_domains");
    expect(role).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(role);
    expect(rcd).toBeGreaterThan(role);
    expect(update).toBeGreaterThan(Math.max(status, rcd));
  });

  it("keeps the original update body unchanged", () => {
    const body = (f: string) => strip(f.slice(f.indexOf("update tenant_custom_domains")));
    expect(body(STATE)).toBe(body(fnText(STATE_ORIGINAL, "set_tenant_custom_domain_state")));
  });
});

describe("set_tenant_custom_domain server-only render_custom_domain_id (20261003160000)", () => {
  it("replaces the latest definition with the identical signature, definer and search_path", () => {
    expect(header(SQL, "set_tenant_custom_domain")).toBe(header(ADD_ORIGINAL, "set_tenant_custom_domain"));
  });

  it("refuses a JWT caller whose render_custom_domain_id differs from the tenant's stored row", () => {
    expect(ADD).toMatch(
      /if auth\.uid\(\) is not null and p_render_custom_domain_id is not null then\s+select render_custom_domain_id into v_stored\s+from tenant_custom_domains\s+where hostname = v_host and tenant_id = p_tenant_id;\s+if p_render_custom_domain_id is distinct from v_stored then\s+raise exception 'set_tenant_custom_domain: render_custom_domain_id can only be set by the server'\s+using errcode = '42501';/,
    );
    expect(ADD).toMatch(/v_stored text;/);
  });

  it("runs the new check after hostname validation and before the insert", () => {
    const host = ADD.indexOf("invalid custom hostname");
    const rcd = ADD.indexOf("render_custom_domain_id can only be set by the server");
    const insert = ADD.indexOf("insert into tenant_custom_domains");
    expect(host).toBeGreaterThan(-1);
    expect(rcd).toBeGreaterThan(host);
    expect(insert).toBeGreaterThan(rcd);
  });

  it("is otherwise the 20261003150000 body verbatim", () => {
    const orig = fnText(ADD_ORIGINAL, "set_tenant_custom_domain");
    const withoutNew = ifBlocks(ADD).filter((b) => !b.includes("can only be set by the server"));
    expect(withoutNew.map(strip)).toEqual(ifBlocks(orig).map(strip));
    const tail = (f: string) => strip(f.slice(f.indexOf("insert into tenant_custom_domains")));
    expect(tail(ADD)).toBe(tail(orig));
  });
});

describe("20261003160000 grants and shape", () => {
  it("keeps both functions' original grants", () => {
    for (const sig of [STATE_SIG, ADD_SIG]) {
      expect(SQL).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function ${sig} to authenticated, service_role;`);
    }
  });

  it("is one transaction with no data change outside the function bodies", () => {
    expect(SQL.trim().startsWith("begin;")).toBe(true);
    expect(SQL.trim().endsWith("commit;")).toBe(true);
    const outside = SQL.replace(STATE, "").replace(ADD, "");
    expect(outside).not.toMatch(/\b(insert into|update |delete from|drop |alter table|truncate)\b/i);
  });
});
