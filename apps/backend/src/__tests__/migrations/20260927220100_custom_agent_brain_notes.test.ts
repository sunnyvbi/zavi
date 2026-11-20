import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, "20260927220100_custom_agent_brain_notes.sql"), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

describe("custom_agent_brain_notes migration", () => {
  it("adds nullable provenance columns to memory_note", () => {
    expect(sql).toMatch(/add column custom_agent_id uuid references custom_agents\(id\) on delete set null/);
    expect(sql).toMatch(/add column run_id uuid references agent_runs\(id\) on delete set null/);
  });

  const fn = sql.slice(sql.indexOf("create or replace function delete_custom_agent_note"));

  it("is security definer with a pinned search_path", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
  });

  it("re-checks membership and deletes only this tenant's notes of this agent", () => {
    expect(fn).toMatch(/perform _custom_agent_authorize\(p_tenant_id\)/);
    const del = fn.slice(fn.indexOf("delete from memory_note"), fn.indexOf("return found"));
    expect(del).toMatch(/tenant_id = p_tenant_id/);
    expect(del).toMatch(/custom_agent_id = p_agent_id/);
    expect(del).toMatch(/slug is null/);
  });

  it("writes the redacted memory mutation audit in the SAME function, only after a real delete", () => {
    const afterDelete = fn.slice(fn.indexOf("returning * into v_note"));
    expect(afterDelete).toMatch(/if not found then\s+return false;/);
    const insert = afterDelete.slice(afterDelete.indexOf("insert into memory_mutation_audit"));
    expect(insert).toMatch(/auth\.uid\(\)/);
    expect(insert).toMatch(/'delete'/);
    expect(insert).toMatch(/'redaction',\s*'rtbf_delete'/);
    expect(insert).toMatch(/'title_sha256',\s*left\(encode\(sha256\(convert_to\(coalesce\(v_note\.title, ''\), 'utf8'\)\), 'hex'\), 16\)/);
    expect(insert).not.toMatch(/body_markdown/);
    expect(insert).not.toMatch(/'title',/);
  });

  it("is revoked from public and anon, granted to authenticated", () => {
    expect(sql).toMatch(/revoke all on function delete_custom_agent_note\(uuid, uuid, uuid\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function delete_custom_agent_note\(uuid, uuid, uuid\) to authenticated, service_role/);
  });
});
