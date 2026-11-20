import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101140000_tiktok_launch_claims.sql";
const code = readFileSync(join(MIGRATIONS, FILE), "utf-8").replace(/--[^\n]*/g, "");

describe(FILE, () => {
  it("sorts after the TikTok launch migration and reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261028130000_tiktok_ads_launch.sql"));
    expect(all.filter((f) => f.startsWith("20261101140000_"))).toEqual([FILE]);
  });
  it("one claim per tenant and ad account; RLS on; service role only; nothing else", () => {
    expect(code).toContain("primary key (tenant_id, advertiser_id)");
    expect(code).toContain("alter table public.tiktok_launch_claims enable row level security;");
    expect(code).toContain("revoke all on public.tiktok_launch_claims from public, anon, authenticated;");
    expect(code).toContain("grant all on public.tiktok_launch_claims to service_role;");
    expect(code).not.toMatch(/create policy|create (or replace )?function|\bdrop\s|alter table public\.(?!tiktok_launch_claims)/i);
  });
});
