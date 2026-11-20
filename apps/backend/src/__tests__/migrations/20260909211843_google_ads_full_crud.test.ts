import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const FILE = "20260909211843_google_ads_full_crud.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

const NEW_CLASSES = [
  "google_ads.create_campaign",
  "google_ads.update_campaign",
  "google_ads.create_ad_group",
  "google_ads.update_ad_group",
  "google_ads.create_ad",
  "google_ads.add_keywords",
  "google_ads.remove_resource",
];

describe("google ads full crud migration", () => {
  it("registers every new class with the six-column insert and its same-named handler", () => {
    expect(flat).toContain(
      "decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable)",
    );
    for (const slug of NEW_CLASSES) {
      expect(flat).toContain(`'${slug}'`);
      expect(flat).toMatch(new RegExp(`'approval',\\s*'${slug.replace(".", "\\.")}'`));
    }
    expect(flat).toContain("on conflict (slug) do nothing");
  });

  it("never seeds an auto route for any new google_ads class", () => {
    expect(flat).not.toMatch(/'auto',\s*'google_ads\./);
  });

  it("clamps create_campaign, remove_resource and both review classes to never_auto", () => {
    expect(flat).toMatch(
      /update decision_classes\s+set never_auto = true,\s+click_allowlistable = false\s+where slug in \(\s*'google_ads\.create_campaign',\s*'google_ads\.remove_resource',\s*'google_ads\.update_campaign_budget_review',\s*'google_ads\.set_status_review'\s*\)/,
    );
  });
});
