import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adsAutopilotBodySchema } from "@/routes/approvals/ads-autopilot";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261123100000_linkedin_ads_autopilot_caps.sql"), "utf-8");
const prior = readFileSync(join(dir, "20261024090000_meta_ads_campaign_budget_classes.sql"), "utf-8");
const body = (s: string) => s.slice(s.indexOf("create or replace function set_tenant_ads_autopilot"), s.indexOf("grant execute")).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("20261123100000_linkedin_ads_autopilot_caps.sql", () => {
  it("the route accepts linkedin_ads as an autopilot platform and still refuses others", () => {
    expect(adsAutopilotBodySchema.safeParse({ platform: "linkedin_ads", enabled: true, max_daily_budget_usd: 10 }).success).toBe(true);
    expect(adsAutopilotBodySchema.safeParse({ platform: "tiktok_ads", enabled: true, max_daily_budget_usd: 10 }).success).toBe(false);
  });
  it("widens the caps platform check to linkedin_ads under the same constraint name", () => {
    expect(sql).toMatch(/drop constraint if exists tenant_ads_write_caps_platform_chk/);
    expect(sql).toMatch(/add constraint tenant_ads_write_caps_platform_chk\s*check \(platform in \('meta_ads', 'google_ads', 'linkedin_ads'\)\)/);
  });
  it("replaces set_tenant_ads_autopilot with a superset of the prior body", () => {
    const next = body(sql);
    const lost = body(prior).split("\n").filter((l) => l.trim() && !next.includes(l) && !/p_platform not in|when 'meta_ads'|when 'google_ads'/.test(l));
    expect(lost).toEqual([]);
    expect(next).toMatch(/p_platform not in \('meta_ads', 'google_ads', 'linkedin_ads'\)/);
    expect(next).toMatch(/when 'linkedin_ads' then array\['linkedin_ads\.update_campaign_budget'\]/);
    expect(next).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function set_tenant_ads_autopilot\(uuid, uuid, text, boolean, numeric\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function set_tenant_ads_autopilot\(uuid, uuid, text, boolean, numeric\) to service_role/);
  });
});
