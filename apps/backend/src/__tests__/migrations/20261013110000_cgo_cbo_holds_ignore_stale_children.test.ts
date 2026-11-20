import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261013110000_cgo_cbo_holds_ignore_stale_children.sql";
const PRIOR = "20261012140000_cgo_spend_holds_cbo_and_freshness.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const read = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const fnIn = (text: string, name: string) => {
  const at = text.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return text.slice(at, text.indexOf("end $$;", at));
};
const code = (t: string) => t.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
const FUNCS = ["release_idle_ad_holds", "shrink_underdelivering_ad_holds"] as const;

describe("20261013110000_cgo_cbo_holds_ignore_stale_children", () => {
  it("sorts after every earlier migration", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1] === FILE || all.indexOf(FILE) > all.indexOf("20261013100000_setup_draft_refund_to_source_buckets.sql")).toBe(true);
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf(PRIOR));
  });

  it("rebuilds each function from its LATEST prior definition: no file in between redefines it", () => {
    for (const name of FUNCS) {
      expect(read(PRIOR)).toContain(`create or replace function public.${name}(`);
      const between = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > PRIOR && f < FILE);
      for (const f of between) expect(read(f), `${f} redefines ${name}`).not.toContain(`function public.${name}(`);
    }
  });

  it("keeps every prior line except the CBO freshness aggregation it replaces", () => {
    const changed: Record<(typeof FUNCS)[number], string[]> = {
      release_idle_ad_holds: [],
      shrink_underdelivering_ad_holds: [
        "             bool_and(c.as_of >= now() - interval '3 hours')",
        "               and bool_or(upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED'))",
      ],
    };
    for (const name of FUNCS) {
      const after = new Set(fnIn(sql, name).split("\n"));
      expect(code(fnIn(read(PRIOR), name)).filter((l) => !after.has(l)), name).toEqual(changed[name]);
    }
  });

  it("every CBO branch leaves out child rows older than 3 hours BEFORE aggregating", () => {
    for (const name of FUNCS) {
      const f = fnIn(sql, name);
      const branches = [...f.matchAll(/c\.platform = 'meta' and c\.level = 'ad_set' and c\.campaign_id is not null\n\s+and c\.as_of >= now\(\) - interval '3 hours'/g)];
      expect(branches.length, name).toBe(name === "shrink_underdelivering_ad_holds" ? 2 : 1);
    }
    expect(fnIn(sql, "release_idle_ad_holds")).toContain("if not v_whole then");
    expect(fnIn(sql, "shrink_underdelivering_ad_holds")).toContain("v_budget.actual_read_at < now() - interval '3 hours'");
  });

  it("security definer, pinned search_path, service-role only, registered", () => {
    for (const name of FUNCS) {
      expect(fnIn(sql, name)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${name}(uuid) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(uuid) to service_role;`);
      expect(registry).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/create table|create policy|drop function/i);
  });
});
