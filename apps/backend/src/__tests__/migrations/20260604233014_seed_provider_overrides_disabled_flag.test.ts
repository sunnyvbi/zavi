import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260604233014_seed_provider_overrides_disabled_flag.sql",
);

describe("20260604233014_seed_provider_overrides_disabled_flag.sql", () => {
  it("migration file exists", () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const sql = readFileSync(PATH, "utf-8");

  it("seeds the provider_overrides_disabled key into the system_config blob", () => {
    expect(sql).toMatch(/provider_overrides_disabled/);
    expect(sql).toMatch(/jsonb_set\(blob,\s*'\{provider_overrides_disabled\}'/i);
  });

  it("defaults the master-kill flag to false (feature dormant)", () => {
    expect(sql).toMatch(
      /jsonb_set\(blob,\s*'\{provider_overrides_disabled\}',\s*'false'::jsonb/i,
    );
  });

  it("targets the single system_config row (id = 1)", () => {
    expect(sql).toMatch(/update system_config/i);
    expect(sql).toMatch(/where id = 1/i);
  });

  it("does NOT create a table or RPC (seed-only, additive)", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/create or replace function/i);
  });
});
