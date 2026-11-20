
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119130000_creator_earn_mode.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf-8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const fnBody = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("end $$;", start));
};

describe(FILE, () => {
  it("adds earn_mode as a nullable column that only takes the three modes", () => {
    expect(sql).toMatch(/add column if not exists earn_mode text\s+check \(earn_mode is null or earn_mode in \('affiliate', 'jobs', 'both'\)\)/);
  });

  it.each(["search_creators", "search_human_members"])("is the newest definition of %s", (name) => {
    const later = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql") && f > FILE)
      .filter((f) => new RegExp(`function\\s+${name}`, "i").test(readFileSync(join(MIG_DIR, f), "utf-8")));
    expect(later).toEqual([]);
  });

  it.each(["search_creators", "search_human_members"])("%s keeps the vetting and payout gates and leaves out affiliate only", (name) => {
    const body = fnBody(name);
    expect(body).toMatch(/m\.vetting_state = 'approved'/);
    expect(body).toMatch(/creator_payout_country_supported\(m\.country_code\)/);
    expect(body).toMatch(/and m\.earn_mode is distinct from 'affiliate'/);
  });

  it("search_creators keeps 20261112130100's UGC-only package filter", () => {
    const body = fnBody("search_creators");
    expect(body).toMatch(/array_remove\(coalesce\(m\.lanes, '\{\}'::text\[\]\), 'audience_post'\)/);
    expect(body).toMatch(/p_lane = 'ugc_video' and p_lane = any/);
    expect(body).not.toMatch(/post_count/);
  });

  it("sorts after every migration on main before it", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261119120000_linkedin_ads_refused_post_not_retryable.sql"));
  });

  it("re-states both functions as service_role only, and drops nothing", () => {
    expect(sql).toMatch(/revoke execute on function search_creators\([^)]*\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function search_creators\([^)]*\)\s+to service_role;/);
    expect(sql).toMatch(/revoke execute on function search_human_members\(uuid, text, text\[\], numeric\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant\s+execute on function search_human_members\(uuid, text, text\[\], numeric\) to service_role;/);
    expect(sql).not.toMatch(/drop (table|column|function)/i);
  });
});
