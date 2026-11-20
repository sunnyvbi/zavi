import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261026100000_tiktok_ads_held_writes.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");

function fn(file: string, name: string): string {
  const all = [...read(file).matchAll(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
  if (!all.length) throw new Error(`${name} not in ${file}`);
  return all[all.length - 1][0];
}

function live(name: string): string {
  let t = fn("20261023125328_chatgpt_growth_autopilot.sql", name);
  t = t.replaceAll("'meta', 'google'", "'meta', 'google', 'reddit'");
  t = t.replaceAll("'meta', 'google'", "'meta', 'google', 'x'");
  if (name !== "shrink_underdelivering_ad_holds") t = t.replaceAll("p_platform = 'chatgpt' then 2", "p_platform in ('chatgpt', 'x') then 2");
  else t = t.replaceAll("r.platform <> 'chatgpt'", "r.platform not in ('chatgpt', 'x')");
  return t;
}

describe(FILE, () => {
  it("sorts after the migrations whose live text it patches", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const prior of ["20261025120000_reddit_ads_execution.sql", "20261025130000_x_ads_management_and_budget.sql", "20261025140000_ad_ledger_all_platforms.sql"]) {
      expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf(prior));
    }
  });

  it("no later migration re-creates the patched functions from a file", () => {
    const REBUILT = "20261107110000_ad_holds_bounded_by_object.sql";
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 14) > "20261023125328" && f !== FILE && f !== REBUILT);
    for (const f of later) expect(read(f)).not.toMatch(/create (or replace )?function public\.(reserve_ad_spend|rebase_ad_spend_for_object|shrink_underdelivering_ad_holds)\(/);
  });

  it("every anchor it replaces is in the live text, and each patch adds tiktok at 1x", () => {
    for (const name of ["reserve_ad_spend", "rebase_ad_spend_for_object"]) {
      const t = live(name);
      expect(t).toContain("not in ('meta', 'google', 'x', 'reddit', 'chatgpt')");
      expect(t).toContain("p_platform in ('chatgpt', 'x') then 2");
      expect(t).not.toContain("'tiktok'");
      const patched = t.replaceAll("not in ('meta', 'google', 'x', 'reddit', 'chatgpt')", "not in ('meta', 'google', 'x', 'reddit', 'chatgpt', 'tiktok')");
      expect(patched).toContain("'tiktok'");
      expect(patched).not.toMatch(/tiktok'\) then 2/);
    }
    expect(live("shrink_underdelivering_ad_holds")).toContain("r.platform not in ('chatgpt', 'x')");
  });

  it("the migration uses exactly those anchors and raises when any is gone", () => {
    expect(sql).toContain("'not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'')'");
    expect(sql).toContain("'not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'', ''tiktok'')'");
    expect(sql).toContain("'r.platform not in (''chatgpt'', ''x'', ''tiktok'')'");
    expect((sql.match(/raise exception 'tiktok_ads_held_writes:/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(sql).not.toMatch(/replace\([^;]*then 2[^;]*tiktok/);
  });

  it("touches only what a hold needs (the ledger already takes tiktok)", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/record_ad_ledger_read|record_ad_object_changes|ad_campaigns'::regclass|ad_spend_daily'::regclass|ad_object_changes'::regclass/);
    expect(sql).toContain("conrelid = 'public.ad_budget_reservations'::regclass");
    expect(read("20261023125328_chatgpt_growth_autopilot.sql")).toMatch(/ad_budget_plan_platform_check check \(platform in \([^)]*'tiktok'/);
  });
});
