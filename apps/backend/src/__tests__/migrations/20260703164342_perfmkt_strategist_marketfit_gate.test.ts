
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const FILE = "20260703164342_perfmkt_strategist_marketfit_gate.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

describe("perfmkt strategist market-fit gate migration", () => {
  it("registers the parked class with default_autonomy='auto' and its own handler", () => {
    expect(flat).toContain("insert into decision_classes");
    expect(flat).toContain("'perfmkt.create_ad_set_pending_strategist'");
    expect(flat).toContain(
      "decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable)",
    );
    expect(flat).toMatch(/'auto',\s*'perfmkt\.create_ad_set_pending_strategist',\s*false,\s*false/);
    expect(flat).toContain("on conflict (slug) do nothing");
  });

  it("is NOT under the meta_ads.% namespace (no proposals/revision leak)", () => {
    expect(flat).not.toContain("meta_ads.create_ad_set_pending");
  });

  it("clamps the FINAL meta_ads.create_ad_set to never_auto=true (Codex P1-1)", () => {
    expect(flat).toMatch(/update decision_classes\s+set never_auto = true,\s+click_allowlistable = false\s+where slug = 'meta_ads\.create_ad_set'/);
  });

  it("creates the review-state table keyed by pending_decision_id with the terminal lifecycle", () => {
    expect(flat).toContain("create table if not exists ad_set_strategist_reviews");
    expect(flat).toContain("pending_decision_id  uuid        primary key".replace(/\s+/g, " "));
    expect(flat).toContain("check (status in ('pending','resolving','approved','bounced','failed'))");
    expect(flat).toContain("references decisions(id) on delete cascade");
    expect(flat).toContain("references tenants(id) on delete cascade");
  });

  it("enables RLS on the review-state table (service-role only)", () => {
    expect(flat).toContain("alter table ad_set_strategist_reviews enable row level security");
  });
});
