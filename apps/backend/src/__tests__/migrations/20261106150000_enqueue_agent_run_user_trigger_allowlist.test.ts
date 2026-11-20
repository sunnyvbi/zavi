import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261106150000_enqueue_agent_run_user_trigger_allowlist.sql"), "utf8");
const prior = readFileSync(join(dir, "20260924130200_setup_draft_admission_bridge.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const GUARD =
  /\s*-- RUN IDENTITY \(20261106150000\)[^\n]*\n(\s*--[^\n]*\n)*\s*if auth\.uid\(\) is not null and p_trigger not in \('chat', 'manual'\) then\s+raise exception 'trigger % is server-only', p_trigger using errcode = '42501';\s+end if;\n/;

describe("20261106150000_enqueue_agent_run_user_trigger_allowlist", () => {
  const next = fnOf(sql, "enqueue_agent_run");
  it("refuses a signed-in caller any trigger but chat and manual, after the membership gate", () => {
    expect(next).toMatch(GUARD);
    expect(next.search(GUARD)).toBeGreaterThan(next.indexOf("not a member of tenant"));
  });
  it("is the 20260924130200 body plus ONLY that guard", () => {
    expect(norm(next.replace(GUARD, "\n"))).toBe(norm(fnOf(prior, "enqueue_agent_run")));
  });
  it("keeps the grants: signed-in callers and the service role, never anon", () => {
    expect(sql).toContain("revoke all on function enqueue_agent_run(uuid, text, text, text, jsonb, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to authenticated, service_role;");
  });
});
