import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { creditAllowanceFor, FREE_CREDIT_ALLOWANCE,
  freeDailyCreditsFromBlob,
} from "../credits";

const PLAN_CONTRACT: Array<[string, number]> = [
  ["solo", 20000],
  ["team", 80000],
  ["full", 300000],
  ["enterprise", 20000000],
];

function readMigrationSql(): string {
  const migDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const defining = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) =>
      /function\s+_credit_allowance_for_tenant/i.test(readFileSync(join(migDir, f), "utf8")),
    )
    .sort();
  const file = defining.at(-1);
  if (!file) throw new Error("no migration defines _credit_allowance_for_tenant in " + migDir);
  return readFileSync(join(migDir, file), "utf8");
}

describe("creditAllowanceFor — unit", () => {
  it.each(PLAN_CONTRACT)("plan %s → %i", (plan, credits) => {
    expect(creditAllowanceFor(plan)).toBe(credits);
  });

  it("full → 300000", () => {
    expect(creditAllowanceFor("full")).toBe(300000);
  });

  it("free / unknown plan → FREE_CREDIT_ALLOWANCE floor (display uses the live daily grant)", () => {
    expect(creditAllowanceFor("free")).toBe(FREE_CREDIT_ALLOWANCE);
    expect(creditAllowanceFor("free")).toBe(40000);
    expect(creditAllowanceFor("some-unknown-plan")).toBe(FREE_CREDIT_ALLOWANCE);
  });
});

describe("creditAllowanceFor parity: TS ↔ SQL _credit_allowance_for_tenant", () => {
  const sql = readMigrationSql();

  it.each(PLAN_CONTRACT)("SQL has `when s.plan = '%s' then %i`", (plan, credits) => {
    const re = new RegExp(`s\\.plan = '${plan}'\\s+then\\s+${credits}\\b`);
    expect(re.test(sql)).toBe(true);
  });

  it("SQL else-default DELEGATES free to the runtime daily grant, not a constant", () => {
    expect(/else\s+_free_daily_credits\(\)/.test(sql)).toBe(true);
    expect(new RegExp(`else\\s+${FREE_CREDIT_ALLOWANCE}\\b`).test(sql)).toBe(false);
  });
});

describe("freeDailyCreditsFromBlob — the live free-tier grant", () => {
  it("reads the live daily grant (string, as Postgres ->> returns it)", () => {
    expect(freeDailyCreditsFromBlob({ free_daily_credits: "5000" })).toBe(5000);
  });

  it("reads it as a number too", () => {
    expect(freeDailyCreditsFromBlob({ free_daily_credits: 5000 })).toBe(5000);
  });

  it("returns null when absent, so the caller can fall back deliberately", () => {
    expect(freeDailyCreditsFromBlob({})).toBeNull();
    expect(freeDailyCreditsFromBlob(null)).toBeNull();
    expect(freeDailyCreditsFromBlob(undefined)).toBeNull();
  });

  it("returns null on junk rather than rendering NaN or 0 to a customer", () => {
    expect(freeDailyCreditsFromBlob({ free_daily_credits: "abc" })).toBeNull();
    expect(freeDailyCreditsFromBlob({ free_daily_credits: 0 })).toBeNull();
    expect(freeDailyCreditsFromBlob({ free_daily_credits: -5 })).toBeNull();
  });

  it("matches the SQL: a fraction or a formatted string is unusable, not rounded", () => {
    expect(freeDailyCreditsFromBlob({ free_daily_credits: 1000.5 })).toBeNull();
    expect(freeDailyCreditsFromBlob({ free_daily_credits: "1,000" })).toBeNull();
    expect(freeDailyCreditsFromBlob({ free_daily_credits: "1000.5" })).toBeNull();
    expect(freeDailyCreditsFromBlob({ free_daily_credits: 99_999_999_999 })).toBeNull();
  });

  it("is NOT the retired monthly constant", () => {
    expect(freeDailyCreditsFromBlob({ free_daily_credits: "5000" })).not.toBe(
      FREE_CREDIT_ALLOWANCE,
    );
  });
});
