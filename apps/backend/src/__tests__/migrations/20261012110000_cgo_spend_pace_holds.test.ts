import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261012110000_cgo_spend_pace_holds.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const read = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const fnIn = (text: string, name: string) => {
  const at = text.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  const end = text.indexOf("\n$$;", at);
  const plpgsql = text.indexOf("end $$;", at);
  return text.slice(at, plpgsql >= 0 && (end < 0 || plpgsql < end) ? plpgsql : end);
};
const code = (t: string) => t.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));

const REBUILT: Record<string, string> = {
  reserve_ad_spend: "20261005140000_autopilot_tracking_links.sql",
  rebase_ad_spend_for_object: "20260930030000_ad_budget_brake.sql",
  ad_budget_month_view: "20261005090000_creator_hire_budget.sql",
  _ad_budget_held_usd: "20260929010000_ad_budget_monthly.sql",
};

describe("20261012110000_cgo_spend_pace_holds", () => {
  it("sorts after every earlier migration", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(FILE);
    expect(FILE > "20261012090000_site_shard_metrics_freshness.sql").toBe(true);
  });

  it("each rebuilt function starts from its LATEST prior definition: no file in between redefines it", () => {
    for (const [name, prior] of Object.entries(REBUILT)) {
      const between = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > prior && f < FILE);
      for (const f of between) expect(read(f), `${f} redefines ${name}`).not.toContain(`function public.${name}(`);
      expect(read(prior)).toContain(`create or replace function public.${name}(`);
    }
  });

  it("each rebuilt function is a superset of its prior body (only the listed lines change)", () => {
    const changed: Record<string, string[]> = {
      reserve_ad_spend: ["  p_decision_id       uuid default null", "  if v_delta = 0 then"],
      rebase_ad_spend_for_object: [],
      ad_budget_month_view: [],
      _ad_budget_held_usd: [],
    };
    for (const [name, prior] of Object.entries(REBUILT)) {
      const before = fnIn(read(prior), name);
      const after = new Set(fnIn(sql, name).split("\n"));
      expect(code(before).filter((l) => !after.has(l)), name).toEqual(changed[name]);
    }
  });

  it("margin: default 1.0, active budgets set to 1.0, the >= 1 check untouched", () => {
    expect(sql).toContain("alter table public.ad_budgets alter column margin set default 1.0;");
    expect(sql).toMatch(/update public\.ad_budgets set margin = 1\.0, updated_at = now\(\)\s+where status = 'active' and margin <> 1\.0;/);
    expect(code(sql).join("\n")).not.toMatch(/margin\s*>=?\s*0|drop constraint[^;]*margin/i);
  });

  it("a paused create holds one day; only a create may be paused; a resume adds the rest of the month under the cap", () => {
    const f = fnIn(sql, "reserve_ad_spend");
    expect(f).toMatch(/\n  p_paused\s+boolean default false\n\) returns jsonb/);
    expect(f).toContain("if p_paused and p_op = 'create' then\n    v_amt := ceil(v_delta * v_budget.margin * 100) / 100;");
    expect(f).toContain("set paused = (p_paused and p_op = 'create')");
    expect(f).toContain("v_extra := ceil(v_unpause * greatest(_ad_budget_days_left(v_today) - 1, 0) * v_budget.margin * 100) / 100;");
    expect(f).toContain("v_amt := v_amt + v_extra;");
    expect(f).toMatch(/\+ _creator_hire_used_usd\(v_budget\.id, v_today\)\s+\+ v_amt <= v_cap/);
    expect(f).toContain("if v_delta = 0 and v_extra = 0 then");
    const cap = f.indexOf("+ v_amt <= v_cap");
    const flips = [...f.matchAll(/update ad_budget_reservations set paused = false/g)].map((m) => m.index ?? -1);
    expect(flips).toHaveLength(2);
    expect(flips[1]).toBeGreaterThan(cap);
    expect(f.slice(flips[0] - 200, flips[0])).toContain("if v_delta = 0 and v_extra = 0 then");
  });

  it("held counts a live paused hold once", () => {
    const f = fnIn(sql, "_ad_budget_held_usd");
    expect(f).toContain("when r.status in ('reserved', 'committed') and r.paused then r.daily_delta_usd\n");
    expect(f.indexOf("and r.paused then")).toBeLessThan(f.indexOf("then r.daily_delta_usd * _ad_budget_days_left(p_today)"));
  });

  it("idle release: budget lock first, this tenant only, paused + no delivery + 48h, today stays held", () => {
    const f = fnIn(sql, "release_idle_ad_holds");
    expect(f.indexOf("for update")).toBeGreaterThan(0);
    expect(f.indexOf("for update")).toBeLessThan(f.indexOf("with obj as"));
    expect(f).toContain("where tenant_id = p_tenant_id and status = 'active'");
    expect(f).toContain("o.last_change < now() - interval '48 hours'");
    expect(f).toContain("s.spend_date >= v_today - 2 and s.amount_usd > 0");
    expect(f).toContain("c.as_of < now() - interval '6 hours'");
    expect(f).toContain("set status = 'released', released_on = v_today, reason = 'idle_paused'");
    for (const t of ["ad_spend_daily s", "ad_campaigns c"]) {
      for (const m of f.matchAll(new RegExp(`from ${t}\\s+where ([^\\n]+)`, "g"))) expect(m[1]).toContain("tenant_id = p_tenant_id");
    }
    expect(f).toMatch(/where r\.budget_id = v_budget\.id and r\.tenant_id = p_tenant_id\s+and r\.platform = i\.platform/);
  });

  it("shrink: needs a fresh whole read, only ON objects under 70% for 3 days, 1.2x trailing, through the lower-only rebase", () => {
    const f = fnIn(sql, "shrink_underdelivering_ad_holds");
    const stale = f.indexOf("'stale'");
    expect(stale).toBeGreaterThan(f.indexOf("for update"));
    expect(stale).toBeLessThan(f.indexOf("for v_o in"));
    expect(f).toContain("v_budget.actual_read_at < now() - interval '3 hours'");
    expect(f).toContain("upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED')");
    expect(f).toContain("o.last_change < now() - interval '72 hours'");
    expect(f).toContain("if v_o.trailing < 0.7 * v_o.daily_budget then");
    expect(f).toContain("ceil(v_o.trailing * 1.2 * 100) / 100");
    expect(f).toContain("rebase_ad_spend_for_object(p_tenant_id, v_o.platform, v_o.object_id,");
    expect(f).toContain("having not bool_or(r.status = 'reserved') and not bool_or(r.paused) and not bool_or(r.pause_due)");
  });

  it("rebase keeps a paused-only object one day and refuses a mixed one", () => {
    const f = fnIn(sql, "rebase_ad_spend_for_object");
    expect(f).toContain("if v_mixed then\n    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);");
    expect(f).toContain("set paused = true, amount_usd = ceil(v_new * v_budget.margin * 100) / 100");
  });

  it("the month view returns margin and actual_read_at", () => {
    const f = fnIn(sql, "ad_budget_month_view");
    expect(f).toContain("'margin', v_budget.margin,");
    expect(f).toContain("'actual_read_at', v_budget.actual_read_at,");
  });

  it("every function: security definer where it writes, pinned search_path, service-role only, registered", () => {
    for (const [name, sig] of [
      ["reserve_ad_spend", "uuid, text, text, text, text, numeric, uuid, uuid, boolean"],
      ["rebase_ad_spend_for_object", "uuid, text, text, numeric, text"],
      ["ad_budget_month_view", "uuid"],
      ["release_idle_ad_holds", "uuid"],
      ["shrink_underdelivering_ad_holds", "uuid"],
    ] as const) {
      expect(fnIn(sql, name)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
      expect(registry).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    expect(sql).toContain("drop function if exists public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid);");
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});
