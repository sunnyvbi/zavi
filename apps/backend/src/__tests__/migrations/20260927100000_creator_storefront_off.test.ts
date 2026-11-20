
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260927100000_creator_storefront_off.sql";
const raw = readFileSync(join(MIG_DIR, FILE), "utf-8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const SIG =
  "search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer)";

describe(`${FILE}`, () => {
  it("is the newest definition of search_creators (no later migration redefines it)", () => {
    const later = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql") && f > FILE && f !== "20260927140000_creator_package_kinds.sql" && f !== "20261112130100_remove_audience_post_lane.sql" && f !== "20261119130000_creator_earn_mode.sql")
      .filter((f) => /function\s+search_creators/i.test(readFileSync(join(MIG_DIR, f), "utf-8")));
    expect(later).toEqual([]);
  });

  it("drops the anon-granted storefront read", () => {
    expect(sql).toMatch(/drop function if exists get_creator_storefront\(text\);/);
    expect(sql).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("anon and authenticated are denied search_creators; only service_role may run it", () => {
    expect(sql).toMatch(
      new RegExp(`revoke execute on function ${SIG.replace(/[()[\]]/g, "\\$&")}\\s*from public, anon, authenticated;`),
    );
    expect(sql).toMatch(
      new RegExp(`grant execute on function ${SIG.replace(/[()[\]]/g, "\\$&")}\\s*to service_role;`),
    );
  });

  it("re-creates search_creators with the same signature it dropped", () => {
    expect(sql).toMatch(new RegExp(`drop function if exists ${SIG.replace(/[()[\]]/g, "\\$&")};`));
    expect(sql).toMatch(/create function search_creators\(/);
    expect(sql).toMatch(/security definer\s+stable\s+set search_path = public, pg_temp/);
  });

  it("keeps the tenant membership check for an authenticated caller", () => {
    expect(sql).toMatch(/tu\.user_id = auth\.uid\(\) and tu\.tenant_id = p_tenant_id/);
  });

  it("lists only approved creators in a supported payout country (non-bookable absent)", () => {
    const where = sql.slice(sql.indexOf("from human_members m"), sql.indexOf("order by\n    case"));
    expect(where).toMatch(/m\.vetting_state = 'approved'/);
    expect(where).toMatch(/and creator_payout_country_supported\(m\.country_code\)/);
    expect(where).not.toMatch(/slug is not null/);
  });

  it("returns handles with self-reported followers, and never reads PII", () => {
    expect(sql).toMatch(/'platform', h\.platform, 'handle', h\.handle, 'followers', h\.followers/);
    expect(sql).not.toMatch(/human_member_pii|legal_name|date_of_birth|\bemail\b/);
  });

  it("adds a bounded, nullable followers column", () => {
    expect(sql).toMatch(
      /alter table human_member_handles\s+add column if not exists followers integer\s+check \(followers is null or \(followers >= 0 and followers <= 1000000000\)\);/,
    );
  });

  it("makes creator-media private", () => {
    expect(sql).toMatch(/update storage\.buckets set public = false where id = 'creator-media';/);
  });

  it("runs in one transaction", () => {
    expect(sql.trim().startsWith("begin;")).toBe(true);
    expect(sql.trim().endsWith("commit;")).toBe(true);
  });
});
