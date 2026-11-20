import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const FILE = "20260703173606_perfmkt_strategist_final_create_origin_unique.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

describe("strategist origin partial-unique-index migration", () => {
  it("creates a UNIQUE index on the origin tag", () => {
    expect(flat).toContain("create unique index if not exists decisions_strategist_origin_uq");
    expect(flat).toContain("body -> 'strategist_gate' ->> 'origin_pending_decision_id'");
  });

  it("is PARTIAL — scoped to meta_ads.create_ad_set + non-null tag (pre-existing rows unaffected)", () => {
    expect(flat).toContain("where decision_class = 'meta_ads.create_ad_set'");
    expect(flat).toContain("is not null");
  });
});
