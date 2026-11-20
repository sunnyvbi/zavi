import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20260924130200_setup_draft_admission_bridge.sql"), "utf8");
const priorEnqueue = readFileSync(join(dir, "20260630070500_enqueue_build_credit_universal_exclusion.sql"), "utf8");
const priorFinalize = readFileSync(join(dir, "20260917010000_billing_cancel_to_free_and_no_overdraft.sql"), "utf8");
const reserve = readFileSync(join(dir, "20260906210000_paid_keeps_daily_credit_grant.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const bridge = fnOf(sql, "enqueue_setup_draft");
const resolver = fnOf(sql, "setup_draft_resolve_run");

const GUARD = /\s*-- WELCOME SETUP: the setup draft keys are server-only[^\n]*\n\s*if auth\.uid\(\) is not null and p_cron_dedupe_key like 'cgo:draft:%:setup%' then\s+raise exception 'reserved dedupe key' using errcode = '42501';\s+end if;\n/;
const DEBITED_COLS = /insert into tenant_credit_ledger \(tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt, debited\)/;

describe("20260924130200_setup_draft_admission_bridge", () => {
  it("bridge + resolver: security definer, public, pg_temp, service-role only", () => {
    for (const f of [bridge, resolver]) expect(f).toMatch(/security definer set search_path = public, pg_temp/);
    for (const sig of ["enqueue_setup_draft(uuid, text, jsonb, int)", "setup_draft_resolve_run(uuid)"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
  });
  it("bridge: refuses signed-in callers, attempts outside 1-3, and any payload but the setup draft's", () => {
    expect(bridge).toMatch(/if auth\.uid\(\) is not null then\s+raise exception 'enqueue_setup_draft: service role only'/);
    expect(bridge).toMatch(/p_attempt not between 1 and 3/);
    expect(bridge).toMatch(/p_payload->>'stage' is distinct from 'draft_strategy'/);
    expect(bridge).toMatch(/p_payload->>'origin' is distinct from 'setup_draft'/);
    expect(bridge).toMatch(/k not in \('stage', 'origin', 'research', 'past_work'\)/);
    expect(bridge).toMatch(/v_key := 'cgo:draft:' \|\| p_tenant_id::text \|\| ':setup'/);
  });
  it("bridge: shortfall only, taken back after the enqueue, admission row written with the run", () => {
    expect(bridge).toMatch(/v_bridge := greatest\(v_est - coalesce\(v_avail, 0\), 0\)/);
    const add = bridge.indexOf("purchased_balance = purchased_balance + v_bridge");
    const enq = bridge.indexOf("enqueue_agent_run(");
    const take = bridge.indexOf("purchased_balance = purchased_balance - v_bridge");
    const adm = bridge.indexOf("insert into setup_draft_admissions");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(enq);
    expect(take).toBeGreaterThan(enq);
    expect(adm).toBeGreaterThan(enq);
    expect(bridge).not.toMatch(/exception when/i);
    const formula = "(included_allowance - included_used) + greatest(daily_allowance - daily_used, 0) + purchased_balance - reserved";
    expect(norm(reserve)).toContain(formula);
    expect(norm(bridge)).toContain(formula);
  });
  it("admissions table: RLS on, no policies, one row per (tenant, attempt)", () => {
    expect(sql).toMatch(/create table if not exists setup_draft_admissions/);
    expect(sql).toMatch(/run_id\s+uuid primary key references agent_runs\(id\) on delete cascade/);
    expect(sql).toMatch(/attempt\s+int not null check \(attempt between 1 and 3\)/);
    expect(sql).toMatch(/unique \(tenant_id, attempt\)/);
    expect(sql).toMatch(/alter table setup_draft_admissions enable row level security/);
    expect(sql).not.toMatch(/create policy[^;]*setup_draft_admissions/);
    expect(sql).toMatch(/revoke all on table setup_draft_admissions from anon, authenticated/);
  });
  it("resolver: read-only, and ONLY admitted runs resolve", () => {
    expect(resolver).toMatch(/language sql stable/);
    expect(resolver).toMatch(/join setup_draft_admissions a on a\.run_id = r\.id and a\.tenant_id = r\.tenant_id/);
    expect(resolver).not.toMatch(/\b(insert|update|delete)\b/i);
  });
  it("enqueue_agent_run = the 20260630070500 body + ONLY the reserved-key guard (and the pinned path)", () => {
    const next = fnOf(sql, "enqueue_agent_run");
    expect(next).toMatch(GUARD);
    expect(next).toMatch(/security definer set search_path = public, pg_temp as \$\$/);
    const stripped = norm(next.replace(GUARD, "\n").replace("set search_path = public, pg_temp as $$", () => "set search_path = public as $$"));
    expect(stripped).toBe(norm(fnOf(priorEnqueue, "enqueue_agent_run")));
  });
  it("finalize_run_credits = the 20260917010000 body + ONLY the debited column on the settle insert", () => {
    const next = fnOf(sql, "finalize_run_credits");
    expect(next).toMatch(DEBITED_COLS);
    expect(next).toMatch(/null, p_cost_usd, v_ps, v_attempt, v_from_day \+ v_from_inc \+ v_from_pur\)/);
    const stripped = norm(
      next
        .replace(DEBITED_COLS, "insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt)")
        .replace("null, p_cost_usd, v_ps, v_attempt, v_from_day + v_from_inc + v_from_pur)", "null, p_cost_usd, v_ps, v_attempt)"),
    );
    expect(stripped).toBe(norm(fnOf(priorFinalize, "finalize_run_credits")));
    expect(sql).toMatch(/alter table tenant_credit_ledger add column if not exists debited int/);
  });
  it("pins grant_promo_credits to public, pg_temp and restates its revokes", () => {
    expect(sql).toMatch(/alter function grant_promo_credits\(uuid, int, text, text, text\) set search_path = public, pg_temp;/);
    expect(sql).toContain("revoke all on function grant_promo_credits(uuid, int, text, text, text) from public, anon, authenticated;");
  });
});
