
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260927100100_search_human_members_payable_only.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf-8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe(FILE, () => {
  it("is the newest definition of search_human_members", () => {
    const later = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql") && f > FILE && f !== "20261119130000_creator_earn_mode.sql")
      .filter((f) => /function\s+search_human_members/i.test(readFileSync(join(MIG_DIR, f), "utf-8")));
    expect(later).toEqual([]);
  });

  it("keeps the approved gate and adds the payout-country predicate", () => {
    const where = sql.slice(sql.indexOf("from human_members m"));
    expect(where).toMatch(/m\.vetting_state = 'approved'/);
    expect(where).toMatch(/and creator_payout_country_supported\(m\.country_code\)/);
  });

  it("keeps the neutral order and grants nothing new", () => {
    expect(sql).toMatch(/order by\s+m\.created_at desc,\s+m\.id asc/);
    expect(sql).toMatch(/revoke execute on function search_human_members\(uuid, text, text\[\], numeric\) from public, anon, authenticated;/);
    expect(sql.match(/\bgrant\b/gi) ?? []).toHaveLength(1);
    expect(sql).toMatch(/grant\s+execute on function search_human_members\(uuid, text, text\[\], numeric\) to service_role;/);
  });
});
