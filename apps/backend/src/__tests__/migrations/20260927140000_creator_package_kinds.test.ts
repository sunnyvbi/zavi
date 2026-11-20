
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FILE = "20260927140000_creator_package_kinds.sql";
const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf-8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe(FILE, () => {
  it("widens the platform CHECK to the six platforms", () => {
    const m = sql.match(/creator_packages_platform_check\s+check \(platform is null or platform in \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const list = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(list).toEqual(["tiktok", "instagram", "youtube", "x", "linkedin", "other"]);
  });

  it("adds post_count between 1 and 20, posts only", () => {
    expect(sql).toMatch(/add column if not exists post_count integer\s+check \(post_count is null or post_count between 1 and 20\)/);
    expect(sql).toMatch(/check \(post_count is null or kind = 'audience_post'\)/);
  });

  it("is the newest definition of search_creators until 20261112130100 re-creates it", () => {
    const dir = join(__dirname, "../../../../../supabase/migrations");
    const later = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f > FILE && f !== "20261112130100_remove_audience_post_lane.sql" && f !== "20261119130000_creator_earn_mode.sql")
      .filter((f) => /function\s+search_creators/i.test(readFileSync(join(dir, f), "utf-8")));
    expect(later).toEqual([]);
  });

  it("re-creates search_creators with post_count in each package, grants unchanged", () => {
    expect(sql).toMatch(/create or replace function search_creators\(/);
    expect(sql).toMatch(/'ad_label_required', p\.ad_label_required, 'post_count', p\.post_count\)/);
    expect(sql).toMatch(/where m\.vetting_state = 'approved'/);
    expect(sql).toMatch(/revoke execute on function search_creators\([^)]*\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function search_creators\([^)]*\)\s+to service_role;/);
  });

  it("is additive: drops no table, column or function", () => {
    expect(sql).not.toMatch(/drop (table|column|function)/i);
  });
});
