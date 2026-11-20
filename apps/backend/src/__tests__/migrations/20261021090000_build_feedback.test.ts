import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261021090000_build_feedback.sql"), "utf-8");
const PRIOR = readFileSync(join(DIR, "20260615130000_feedback_rpc_conflict_arbiter_predicate.sql"), "utf-8");

const body = (sql: string) => {
  const m = sql.match(/create or replace function submit_agent_feedback\([\s\S]*?\nend \$\$;/);
  if (!m) throw new Error("submit_agent_feedback not found");
  return m[0];
};

describe("build feedback (20261021090000)", () => {
  it("allows the conductor_run target in the table check and the RPC", () => {
    expect(SQL).toMatch(/target_type in \('agent_run', 'decision', 'conductor_run'\)/);
    expect(body(SQL)).toMatch(/if p_target_type not in \('agent_run', 'decision', 'conductor_run'\)/);
  });

  it("resolves a build's tenant only for a member, only for build_app runs, never from the caller", () => {
    const branch = body(SQL).match(/elsif p_target_type = 'conductor_run' then[\s\S]*?end if;/)![0];
    expect(branch).toMatch(/from public\.conductor_runs c\s+where c\.id = p_target_id\s+and c\.kind = 'build_app'/);
    expect(branch).toMatch(/exists \(\s*select 1 from public\.tenant_users tu\s+where tu\.tenant_id = c\.tenant_id and tu\.user_id = v_user_id/);
    expect(branch).toMatch(/select c\.tenant_id, 'engineer'/);
  });

  it("keeps the prior function otherwise unchanged: membership check, sanitising, partial on-conflict arbiter", () => {
    const strip = (s: string) =>
      body(s)
        .replace(/\s+elsif p_target_type = 'conductor_run' then[\s\S]*?(?=\n  end if;)/, "")
        .replace(/, 'conductor_run'/g, "")
        .replace("set search_path = public, pg_temp", "set search_path = public");
    expect(strip(SQL)).toBe(strip(PRIOR));
    expect(body(SQL)).toMatch(/on conflict \(tenant_id, target_type, target_id, created_by\)\s+where target_id is not null/);
  });

  it("is a security definer with pg_temp pinned, callable by signed-in users only", () => {
    expect(body(SQL)).toMatch(/security definer set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function submit_agent_feedback\(text, uuid, smallint, text\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function submit_agent_feedback\(text, uuid, smallint, text\) to authenticated;/);
  });

  it("keeps build ratings out of the per-agent summary and out of Home's suggestions", () => {
    const summary = SQL.match(/create or replace function agent_feedback_summary\([\s\S]*?\n\$\$;/)![0];
    expect(summary).toMatch(/and af\.target_type is distinct from 'conductor_run'/);
    expect(SQL).toMatch(/revoke all on function agent_feedback_summary\(uuid, int\) from public, anon, authenticated;/);
    const view = SQL.match(/create or replace view public\.home_suggestions[\s\S]*?order by af\.created_at desc;/)![0];
    expect(view).toMatch(/with \(security_invoker = true\)/);
    expect(view).toMatch(/and af\.target_type is distinct from 'conductor_run'/);
  });
});
