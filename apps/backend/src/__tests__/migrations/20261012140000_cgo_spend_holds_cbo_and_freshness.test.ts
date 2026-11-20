import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261012140000_cgo_spend_holds_cbo_and_freshness.sql";
const PRIOR = "20261012110000_cgo_spend_pace_holds.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const read = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const fnIn = (text: string, name: string) => {
  const at = text.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return text.slice(at, text.indexOf("end $$;", at));
};
const code = (t: string) => t.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));

describe("20261012140000_cgo_spend_holds_cbo_and_freshness", () => {
  it("sorts after every earlier migration, and after the holds it rebuilds", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(FILE);
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf(PRIOR));
    expect(FILE > "20261012130100_site_reaper_failed_claim.sql").toBe(true);
  });

  it("rebuilds each hold function from its LATEST prior definition: no file in between redefines it", () => {
    for (const name of ["release_idle_ad_holds", "shrink_underdelivering_ad_holds"]) {
      expect(read(PRIOR)).toContain(`create or replace function public.${name}(`);
      const between = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > PRIOR && f < FILE);
      for (const f of between) expect(read(f), `${f} redefines ${name}`).not.toContain(`function public.${name}(`);
    }
  });

  it("each rebuilt function keeps every prior line except the ones this change replaces", () => {
    const changed: Record<string, string[]> = {
      release_idle_ad_holds: [
        "         select 1 from ad_spend_daily s",
        "          where s.tenant_id = p_tenant_id and s.platform = o.platform and s.object_id = o.object_id",
        "            and s.spend_date >= v_today - 2 and s.amount_usd > 0)",
        "         (exists (",
        "            select 1 from ad_campaigns c",
        "             where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id)",
        "          and not exists (",
        "            select 1 from ad_campaigns c",
        "             where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id",
        "               and (c.as_of < now() - interval '6 hours'",
        "                    or upper(coalesce(c.status, '')) not in",
        "                       ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED'))))",
        "         or (v_whole and o.all_paused",
        "             and not exists (",
        "               select 1 from ad_campaigns c",
        "                where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id))",
      ],
      shrink_underdelivering_ad_holds: [
        "        from (select s.platform, s.object_id, s.spend_date, max(s.amount_usd) as amt",
        "                from ad_spend_daily s",
        "               where s.tenant_id = p_tenant_id and s.spend_date between v_today - 3 and v_today - 1",
        "               group by s.platform, s.object_id, s.spend_date) d",
      ],
    };
    for (const name of Object.keys(changed)) {
      const before = fnIn(read(PRIOR), name);
      const after = new Set(fnIn(sql, name).split("\n"));
      expect(code(before).filter((l) => !after.has(l)), name).toEqual(changed[name]);
    }
  });

  it("D5: idle release needs a fresh whole read and ledger rows under 3 hours", () => {
    const f = fnIn(sql, "release_idle_ad_holds");
    const stale = f.indexOf("if not v_whole then");
    expect(stale).toBeGreaterThan(f.indexOf("for update"));
    expect(stale).toBeLessThan(f.indexOf("with obj as"));
    expect(f).toContain("return jsonb_build_object('status', 'stale', 'released', 0, 'released_daily_usd', 0);");
    expect(f).not.toContain("interval '6 hours'");
    expect([...f.matchAll(/c\.as_of >= now\(\) - interval '3 hours'/g)]).toHaveLength(2);
    expect(f).toContain("o.last_change < now() - interval '48 hours'");
    expect(f).toContain("set status = 'released', released_on = v_today, reason = 'idle_paused'");
  });

  it("F4: a Meta campaign hold is read through its ad sets (campaign_id), in both functions, only when the campaign has no row of its own", () => {
    for (const name of ["release_idle_ad_holds", "shrink_underdelivering_ad_holds"]) {
      const f = fnIn(sql, name);
      expect(f, name).toContain("c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null");
      expect(f, name).toMatch(/not exists \(\s+select 1 from ad_campaigns x\s+where x\.tenant_id = p_tenant_id and x\.platform = c\.platform and x\.object_id = c\.campaign_id\)/);
    }
    const shrink = fnIn(sql, "shrink_underdelivering_ad_holds");
    expect(shrink).toContain("bool_and(c.as_of >= now() - interval '3 hours')\n               and bool_or(upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED'))");
    expect(shrink).toContain("select d.platform, st.campaign_id, sum(d.amt) / 3.0");
    expect(shrink).toContain("v_budget.actual_read_at < now() - interval '3 hours'");
    expect(shrink).toContain("rebase_ad_spend_for_object(p_tenant_id, v_o.platform, v_o.object_id,");
  });

  it("every table read is filtered to the caller's tenant", () => {
    for (const name of ["release_idle_ad_holds", "shrink_underdelivering_ad_holds", "note_ad_spend_object"]) {
      const f = fnIn(sql, name);
      for (const m of f.matchAll(/from (ad_campaigns|ad_spend_daily|ad_budget_reservations|ad_budgets) (\w+)?\s*\n?\s*where ([^\n]+)/g)) {
        expect(m[3], `${name}: ${m[0]}`).toContain("tenant_id = p_tenant_id");
      }
      for (const m of f.matchAll(/join ad_campaigns c on ([^\n]+)/g)) expect(m[1]).toContain("c.tenant_id = p_tenant_id");
    }
  });

  it("note_ad_spend_object: budget lock first, only an open hold with no object yet, never status or amount", () => {
    const f = fnIn(sql, "note_ad_spend_object");
    expect(f.indexOf("for update")).toBeGreaterThan(0);
    expect(f.indexOf("for update")).toBeLessThan(f.indexOf("update ad_budget_reservations"));
    expect(f).toContain("and status = 'reserved' and object_id is null");
    expect(f).toContain("set object_id = p_object_id, updated_at = now()");
    expect(f).not.toMatch(/\bset [^\n]*\b(status|amount_usd|daily_delta_usd)\s*=/);
  });

  it("every function: security definer, pinned search_path, service-role only, registered", () => {
    for (const [name, sig] of [
      ["release_idle_ad_holds", "uuid"],
      ["shrink_underdelivering_ad_holds", "uuid"],
      ["note_ad_spend_object", "uuid, text, text"],
    ] as const) {
      expect(fnIn(sql, name)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
      expect(registry).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/create table|create policy|drop function/i);
  });
});
