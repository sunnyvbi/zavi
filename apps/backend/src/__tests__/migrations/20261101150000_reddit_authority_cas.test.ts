import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101150000_reddit_authority_cas.sql";
const code = readFileSync(join(MIGRATIONS, FILE), "utf-8").replace(/--[^\n]*/g, "");

describe(FILE, () => {
  it("sorts after the Reddit execution migration and reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261025120000_reddit_ads_execution.sql"));
    expect(all.filter((f) => f.startsWith("20261101150000_"))).toEqual([FILE]);
  });
  it("one statement decides and writes: the upsert's WHERE admits only the same card or a strictly newer one", () => {
    expect(code).toMatch(/on conflict \(tenant_id, ad_account_id\) do update[\s\S]*where a\.action_id = excluded\.action_id\s+or a\.source_proposed_at < excluded\.source_proposed_at;/);
    expect(code).toMatch(/select proposed_at into v_at\s+from channel_actions\s+where tenant_id = p_tenant_id\s+and id = p_action_id\s+and exec_class = 'reddit_ads\.authorize_account'\s+and exec_payload->>'ad_account_id' = p_ad_account_id;/);
    expect(code).toContain("language plpgsql security definer set search_path = public, pg_temp");
    expect(code).toContain("revoke all on function public.save_reddit_ad_authority(uuid, text, jsonb, uuid) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.save_reddit_ad_authority(uuid, text, jsonb, uuid) to service_role;");
    expect(code).not.toMatch(/\bdrop\s/i);
  });
});
