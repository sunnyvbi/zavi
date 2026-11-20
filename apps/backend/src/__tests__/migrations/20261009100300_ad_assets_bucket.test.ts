import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AD_ASSETS_BUCKET, LOGO_MAX_BYTES } from "@/services/tools/google-ads/write/_logo";

const FILE = "20261009100300_ad_assets_bucket.sql";
const code = readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe(FILE, () => {
  it("creates the bucket private, 5 MB, PNG and JPEG only", () => {
    expect(code).toMatch(
      /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+values \('ad-assets', 'ad-assets', false, 5242880, array\['image\/png', 'image\/jpeg'\]\)\s+on conflict \(id\) do nothing;/,
    );
  });

  it("matches the code: bucket name, and the logo cap fits the bucket limit", () => {
    expect(AD_ASSETS_BUCKET).toBe("ad-assets");
    expect(LOGO_MAX_BYTES).toBeLessThanOrEqual(5242880);
  });

  it("grants nothing to anon or authenticated: no storage policy at all", () => {
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/public\s*=\s*true|,\s*true,/i);
  });

  it("runs in one transaction", () => {
    expect(code).toMatch(/^begin;/m);
    expect(code).toMatch(/^commit;/m);
  });
});
