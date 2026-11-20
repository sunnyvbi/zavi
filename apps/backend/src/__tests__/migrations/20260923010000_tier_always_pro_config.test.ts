import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIER_ALWAYS_PRO } from "../../services/billing/tiers";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260923010000_tier_always_pro_config.sql"),
  "utf-8",
);

describe("tier_always_pro config (20260923010000)", () => {
  it("reads system_config.blob.tier_always_pro when it is an array", () => {
    expect(SQL).toMatch(/jsonb_typeof\(sc\.blob->'tier_always_pro'\) = 'array'/);
    expect(SQL).toMatch(/\(sc\.blob->'tier_always_pro'\) \? p_slug/);
  });

  it("falls back to the same list as the TS default", () => {
    const m = SQL.match(/else p_slug in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const slugs = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(slugs).toEqual([...DEFAULT_TIER_ALWAYS_PRO]);
  });

  it("is stable (it reads a table) and keeps the service-role-only grant", () => {
    expect(SQL).toMatch(/_tier_always_pro\(p_slug text\)\s+returns boolean language sql stable security definer/);
    expect(SQL).toMatch(/revoke all on function _tier_always_pro\(text\) from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function _tier_always_pro\(text\) to service_role/);
  });
});
