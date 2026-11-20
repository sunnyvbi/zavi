import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260924131742_merge_website_edit_rpc.sql"),
  "utf8",
);
const body = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  return sql.slice(start, sql.indexOf("end $$;", start));
};

describe("migration 20260924131742_merge_website_edit_rpc", () => {
  it("merge_website_edit is a security definer with a pinned search_path", () => {
    expect(body("merge_website_edit")).toMatch(/security definer set search_path = public, pg_temp/);
  });

  it("serialises writers on one element before it reads the prior draft", () => {
    const fn = body("merge_website_edit");
    const lock = fn.search(/pg_advisory_xact_lock\(/);
    const read = fn.search(/select \* into v_prior/);
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(fn).toMatch(/'website_edit:' \|\| p_tenant_id::text \|\| ':' \|\| p_app_id \|\| ':' \|\| p_selector/);
    expect(fn).toMatch(/for update/);
  });

  it("reads and writes only the injected tenant's row", () => {
    const fn = body("merge_website_edit");
    expect(fn).toMatch(/where tenant_id = p_tenant_id\s+and app_id = p_app_id\s+and selector = p_selector/);
    expect(fn).toMatch(/insert into website_edits \(tenant_id, app_id, selector, patch, removed, updated_at\)\s+values \(p_tenant_id,/);
    expect(fn).toMatch(/on conflict \(tenant_id, app_id, selector\)/);
  });

  it("merges into the prior draft unless replacing, removing, or reviving a hidden element", () => {
    const fn = body("merge_website_edit");
    expect(fn).toMatch(/elsif coalesce\(p_replace, false\) or not v_found or v_prior\.removed then/);
    expect(fn).toMatch(/v_patch := website_edit_merge_patch\(v_prior\.patch, p_patch\)/);
  });

  it("returns the prior draft so a client can restore it", () => {
    expect(body("merge_website_edit")).toMatch(
      /jsonb_build_object\(\s*'existed', v_found,\s*'patch',\s+case when v_found then v_prior\.patch else null end,/,
    );
  });

  it("merge_patch overlays style and attrs key by key and lets text and runs replace each other", () => {
    const fn = body("website_edit_merge_patch");
    expect(fn).toMatch(/v_out := \(v_out - 'segments'\) \|\| jsonb_build_object\('text', v_next->'text'\)/);
    expect(fn).toMatch(/v_out := \(v_out - 'text'\) \|\| jsonb_build_object\('segments', v_next->'segments'\)/);
    expect(fn).toMatch(/\|\| \(v_next->'style'\)/);
    expect(fn).toMatch(/\|\| \(v_next->'attrs'\)/);
  });

  it("merge_patch keeps the prior run wherever a same-length rewrite says null", () => {
    const fn = body("website_edit_merge_patch");
    expect(fn).toMatch(/jsonb_array_length\(v_out->'segments'\) = jsonb_array_length\(v_next->'segments'\)/);
    expect(fn).toMatch(/case when jsonb_typeof\(n\.elem\) = 'null' then p\.elem else n\.elem end order by n\.ord/);
  });

  it("neither function is callable by anon or authenticated; only service_role", () => {
    for (const sig of [
      "website_edit_merge_patch(jsonb, jsonb)",
      "merge_website_edit(uuid, text, text, jsonb, boolean, boolean)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|authenticated)/);
  });
});
