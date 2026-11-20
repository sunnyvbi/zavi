import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { videoSourceKey } from "@/services/connectors/tiktok-ads/video-uploads";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101120000_tiktok_ad_video_uploads.sql";
const code = readFileSync(join(MIGRATIONS, FILE), "utf-8").replace(/--[^\n]*/g, "");

describe(FILE, () => {
  it("sorts after the TikTok launch migration and reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261028130000_tiktok_ads_launch.sql"));
    expect(all.filter((f) => f.startsWith("20261101120000_"))).toEqual([FILE]);
  });

  it("one row per tenant, ad account and video source; RLS on; service role only; no function, policy or drop", () => {
    expect(code).toContain("primary key (tenant_id, advertiser_id, source_key)");
    expect(code).toContain("tenant_id     uuid not null references public.tenants(id) on delete cascade");
    expect(code).toContain("alter table public.tiktok_ad_video_uploads enable row level security;");
    expect(code).toContain("revoke all on public.tiktok_ad_video_uploads from public, anon, authenticated;");
    expect(code).toContain("grant all on public.tiktok_ad_video_uploads to service_role;");
    expect(code).not.toMatch(/create policy|create (or replace )?function|\bdrop\s/i);
  });

  it("the source_key check accepts exactly the keys the code writes", () => {
    const check = /source_key ~ '([^']+)'/.exec(code)?.[1];
    expect(check).toBeDefined();
    const re = new RegExp(check!);
    expect(re.test(videoSourceKey({ artifact_id: "1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED" }))).toBe(true);
    expect(re.test(videoSourceKey({ url: "https://cdn.example.com/clip.mp4?x=1" }))).toBe(true);
    expect(re.test("link:not-a-hash")).toBe(false);
  });
});
