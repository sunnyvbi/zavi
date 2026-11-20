import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { reserveEstimateFor, DEFAULT_RESERVE_ESTIMATE_CREDITS } from "../credits";

const CONTRACT: Array<[string, number]> = [
  ["engineer", 2000],
  ["product-builder", 2400],
  ["fundraising", 500],
  ["growth-lead", 320],
  ["research", 320],
  ["advisor", 320],
  ["cgo", 320],
  ["browser-operator", 240],
  ["performance-marketer", 160],
  ["operator", 160],
  ["pm", 160],
  ["support-lead", 160],
  ["dispute-response", 160],
  ["chief-of-staff", 160],
  ["qa", 160],
];

function readReserveFnSql(): string {
  const migDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const defining = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) =>
      readFileSync(join(migDir, f), "utf8").includes(
        "create or replace function _reserve_estimate_for",
      ),
    )
    .sort();
  const file = defining.at(-1);
  if (!file) throw new Error("no migration defines _reserve_estimate_for in " + migDir);
  return readFileSync(join(migDir, file), "utf8");
}

function readWiringMigrationSql(): string {
  const migDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const file = readdirSync(migDir).find((f) => f.includes("credit_billing_p0_full"));
  if (!file) throw new Error("credit-billing migration not found in " + migDir);
  return readFileSync(join(migDir, file), "utf8");
}

describe("reserve-estimate parity: credits.ts ↔ SQL _reserve_estimate_for", () => {
  const sql = readReserveFnSql();
  const wiringSql = readWiringMigrationSql();

  it.each(CONTRACT)("TS reserveEstimateFor(%s) === %i", (slug, credits) => {
    expect(reserveEstimateFor(slug)).toBe(credits);
  });

  it.each(CONTRACT)("SQL _reserve_estimate_for has `when '%s' then %i`", (slug, credits) => {
    const re = new RegExp(`when\\s+'${slug}'\\s+then\\s+${credits}\\b`);
    expect(re.test(sql)).toBe(true);
  });

  it("SQL default matches the TS default", () => {
    const re = new RegExp(`else\\s+${DEFAULT_RESERVE_ESTIMATE_CREDITS}\\b`);
    expect(re.test(sql)).toBe(true);
  });

  const CHANNEL_SLUGS = [
    "google_ads", "seo", "geo", "ugc",
    "linkedin_organic", "reddit_organic", "x_organic",
    "instagram_organic", "tiktok_organic", "youtube_organic",
    "tiktok_ads", "reddit_ads", "chatgpt_ads", "meta_ads",
  ];

  it.each(CHANNEL_SLUGS)("TS reserveEstimateFor(%s) === 340 (measured)", (slug) => {
    expect(reserveEstimateFor(slug)).toBe(340);
  });

  it("channel slugs are NOT listed in the SQL CASE — they ride the else", () => {
    for (const slug of CHANNEL_SLUGS) {
      expect(new RegExp(`when\\s+'${slug}'\\s+then`).test(sql)).toBe(false);
    }
    expect(reserveEstimateFor("some_unlisted_channel")).toBe(DEFAULT_RESERVE_ESTIMATE_CREDITS);
  });

  it("the unmeasured non-channel agents stayed at 160", () => {
    for (const slug of ["pm", "qa", "operator", "support-lead", "performance-marketer"]) {
      expect(reserveEstimateFor(slug)).toBe(160);
    }
  });

  it("the SQL settle peg matches the TS CREDIT_USD peg ($0.0025)", () => {
    expect(wiringSql).toMatch(/ceil\(p_cost_usd \/ 0\.0025\)/);
  });
});

function readLocalLaneMigrationSql(): string {
  const migDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const file = readdirSync(migDir).find((f) =>
    f.includes("credit_billing_local_lane_reserve_and_tenant_gate"),
  );
  if (!file) throw new Error("local-lane reserve migration not found in " + migDir);
  return readFileSync(join(migDir, file), "utf8");
}

describe("local-lane reserve + tenant-gate invariants (migration 20260627110200)", () => {
  const sql = readLocalLaneMigrationSql();
  const reserveBody = (() => {
    const start = sql.indexOf("function _trg_reserve_run_credits()");
    const after = sql.indexOf("function _trg_finalize_run_credits()");
    if (start < 0 || after < 0) throw new Error("trigger bodies not found");
    return sql.slice(start, after);
  })();

  it("reserve trigger gates on the TENANT-SCOPED overload (C6 — not the global no-arg)", () => {
    expect(reserveBody).toMatch(/if not _credits_enforced\(NEW\.tenant_id\) then/);
  });

  it("reserve trigger fires on BOTH queued and running INSERTs (Bug 1 fix)", () => {
    expect(reserveBody).toMatch(/NEW\.status in \('queued',\s*'running'\)/);
  });

  it("reserve trigger does NOT reserve on any TERMINAL status (C1 — record-only branch cut)", () => {
    expect(reserveBody).not.toMatch(/'success'/);
    expect(reserveBody).not.toMatch(/'parse_failed'/);
    expect(reserveBody).not.toMatch(/'dispatch_error'/);
  });

  it("finalize trigger also gates on the tenant-scoped overload", () => {
    const finalizeBody = sql.slice(sql.indexOf("function _trg_finalize_run_credits()"));
    expect(finalizeBody).toMatch(/if not _credits_enforced\(NEW\.tenant_id\) then/);
  });

  it("defines the tenant-scoped _credits_enforced(p_tenant_id) overload + allowlist", () => {
    expect(sql).toMatch(/function _credits_enforced\(p_tenant_id uuid\)/);
    expect(sql).toMatch(/credits_enforced_allowlist/);
  });
});
