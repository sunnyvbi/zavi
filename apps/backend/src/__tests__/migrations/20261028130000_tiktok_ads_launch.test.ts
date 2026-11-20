import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261028130000_tiktok_ads_launch.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const code = sql.replace(/--[^\n]*/g, "");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const ANCHOR = "not in ('meta_tag', 'meta_adset_name', 'google_campaign_name', 'chatgpt_campaign_name')";

function liveNoteRef(): string {
  const all = [...read("20261023125328_chatgpt_growth_autopilot.sql").matchAll(/create (?:or replace )?function public\.note_ad_spend_ref\([\s\S]*?\$\$;/g)];
  return all[all.length - 1][0];
}

describe(FILE, () => {
  it("sorts after the migrations it builds on, and reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const prior of ["20261023125328_chatgpt_growth_autopilot.sql", "20261026100000_tiktok_ads_held_writes.sql", "20261028090000_ad_money_book_snapshot_shadow.sql"]) {
      expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf(prior));
    }
    expect(all.filter((f) => f.startsWith("20261028130000_"))).toEqual([FILE]);
  });

  it("no other migration after the last full definition re-creates or patches note_ad_spend_ref", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 14) > "20261023125328" && f !== FILE);
    for (const f of later) expect(read(f)).not.toMatch(/note_ad_spend_ref/);
  });

  it("the anchor it replaces is in the live text, and the patched text accepts tiktok_tag and every old kind", () => {
    const live = liveNoteRef();
    expect(live).toContain(ANCHOR);
    expect(live).not.toContain("tiktok_tag");
    const patched = live.replace(ANCHOR, "not in ('meta_tag', 'meta_adset_name', 'google_campaign_name', 'chatgpt_campaign_name', 'tiktok_tag')");
    expect(patched).toMatch(/'chatgpt_campaign_name', 'tiktok_tag'\)/);
    expect(patched.replace("'tiktok_tag'", "")).toBe(live.replace(ANCHOR, ANCHOR.replace(")", ", )")));
  });

  it("the migration uses exactly that anchor, raises when it is gone, and touches no money function", () => {
    expect(sql).toContain("'not in (''meta_tag'', ''meta_adset_name'', ''google_campaign_name'', ''chatgpt_campaign_name'')'");
    expect(sql).toContain("'not in (''meta_tag'', ''meta_adset_name'', ''google_campaign_name'', ''chatgpt_campaign_name'', ''tiktok_tag'')'");
    expect((sql.match(/raise exception 'tiktok_ads_launch:/g) ?? []).length).toBeGreaterThanOrEqual(3);
    for (const fn of ["reserve_ad_spend", "settle_ad_spend", "note_ad_spend_object", "resolve_unknown_ad_hold", "rebase_ad_spend_for_object"]) expect(code).not.toContain(fn);
    expect(code).not.toMatch(/\bdrop\s/i);
  });

  it("tiktok_ad_launches: one row per card of this tenant, RLS on, service role only", () => {
    expect(code).toContain("primary key (tenant_id, action_id)");
    expect(code).toContain("foreign key (tenant_id, action_id) references public.channel_actions(tenant_id, id)");
    expect(code).toContain("alter table public.tiktok_ad_launches enable row level security;");
    expect(code).toContain("revoke all on public.tiktok_ad_launches from public, anon, authenticated;");
    expect(code).toContain("grant all on public.tiktok_ad_launches to service_role;");
    expect(code).not.toMatch(/create policy/i);
    expect(code).toMatch(/tag\s+text not null check \(tag ~ '\^zv\[0-9a-f\]\{10\}\$'\)/);
  });
});
