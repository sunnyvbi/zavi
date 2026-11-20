import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261006120000_tool_side_costs_and_late_charge_refund.sql"), "utf8");
const prior = readFileSync(join(dir, "20260927130000_no_charge_on_failed_runs.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  expect(at, `${name} defined`).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const FUNCS: Array<[string, string]> = [
  ["add_run_side_cost", "uuid, uuid, text, numeric, text"],
  ["finalize_run_credits", "uuid, numeric, text"],
  ["record_late_tool_charge", "uuid, uuid, text, uuid, numeric"],
  ["refund_tool_charge", "uuid, uuid, text, numeric"],
];

describe("20261006120000_tool_side_costs_and_late_charge_refund", () => {
  it.each(FUNCS)("%s is service_role only with a pinned search_path", (name, sig) => {
    expect(fnOf(sql, name)).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain(`revoke all on function ${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${name}(${sig}) to service_role;`);
  });

  it("both new tables have RLS on and no client privileges", () => {
    for (const t of ["agent_run_side_costs", "tool_charges"]) {
      expect(sql).toContain(`alter table ${t} enable row level security;`);
      expect(sql).toContain(`revoke all on table ${t} from anon, authenticated;`);
      expect(sql).not.toMatch(new RegExp(`create policy [a-z_]+ on ${t}`));
    }
  });

  it("finalize_run_credits is the 20260927130000 body with ONLY the settle insert widened", () => {
    const next = fnOf(sql, "finalize_run_credits");
    const back = next
      .replace(
        "attempt, debited, debited_daily, debited_included, debited_purchased)",
        "attempt, debited)",
      )
      .replace(
        "v_from_day + v_from_inc + v_from_pur, v_from_day, v_from_inc, v_from_pur)",
        "v_from_day + v_from_inc + v_from_pur)",
      );
    expect(back).not.toBe(next);
    expect(norm(back)).toBe(norm(fnOf(prior, "finalize_run_credits")));
  });

  it("side costs and late charges are idempotent on their keys", () => {
    expect(sql).toMatch(/unique \(run_id, cost_key\)/);
    expect(sql).toMatch(/unique \(run_id, tool_call_id\)/);
    expect((sql.match(/on conflict \(run_id, cost_key\) do nothing/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/on conflict \(run_id, tool_call_id\) do nothing/);
  });

  it("every writer re-derives the tenant from the run row and refuses a mismatch", () => {
    for (const name of ["add_run_side_cost", "record_late_tool_charge"]) {
      const body = fnOf(sql, name);
      expect(body).toMatch(/select tenant_id, finished_at into v_tenant, v_finished\s+from agent_runs where id = p_run_id/);
      expect(body).toMatch(/raise exception 'tenant_mismatch' using errcode = '42501'/);
      expect(body).toMatch(/return 'run_finished'/);
    }
    expect(fnOf(sql, "refund_tool_charge")).toMatch(
      /if v_row\.tenant_id is distinct from p_tenant_id then\s+raise exception 'tenant_mismatch'/,
    );
  });

  it("refund is once per row, capped at reserved, floors at the burn peg", () => {
    const body = fnOf(sql, "refund_tool_charge");
    expect(body).toMatch(/for update;/);
    expect(body).toMatch(/if v_row\.status <> 'reserved' then\s+return jsonb_build_object\('status', 'already'/);
    expect(body).toMatch(/v_actual := least\(p_actual_usd, v_row\.reserved_usd\)/);
    expect(body).toMatch(/v_nominal := floor\(\(v_row\.reserved_usd - v_actual\) \/ 0\.0025\)::int/);
    expect(body).toMatch(/least\(v_debited, greatest\(v_amount - \(v_prev_nom \+ v_nominal\), 0\)\)/);
    expect(body).not.toMatch(/purchased_balance \+ v_i|purchased_balance \+ v_d/);
    expect(body).toMatch(/purchased_balance = purchased_balance \+ v_p/);
  });

  it("the burn peg matches CREDIT_USD", async () => {
    const { CREDIT_USD } = await import("@/services/agents/credits");
    expect(CREDIT_USD).toBe(0.0025);
    const pegs = [...sql.matchAll(/\/ (0\.\d+)/g)].map((m) => Number(m[1]));
    expect(pegs.length).toBeGreaterThanOrEqual(3);
    for (const p of pegs) expect(p).toBe(CREDIT_USD);
  });
});
