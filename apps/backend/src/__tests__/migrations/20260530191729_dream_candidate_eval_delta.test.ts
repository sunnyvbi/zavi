import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260530191729_dream_candidate_eval_delta.sql",
  ),
  "utf-8",
);

describe("20260530191729_dream_candidate_eval_delta.sql", () => {
  it("adds eval_delta as a nullable jsonb column (additive — old rows stay valid)", () => {
    expect(sql).toMatch(/alter table dream_candidates/i);
    expect(sql).toMatch(/add column eval_delta jsonb/i);
    expect(sql).not.toMatch(/add column eval_delta jsonb[^,;]*not null/i);
  });

  it("adds eval_status with a check constraint over the holdout verdict set", () => {
    expect(sql).toMatch(/add column eval_status text/i);
    for (const v of ["improved", "regressed", "neutral", "no_goldens", "unmeasured", "error"]) {
      expect(sql).toContain(`'${v}'`);
    }
    expect(sql).toMatch(/or eval_status is null/i);
  });

  it("is strictly additive — no DROP, no NOT NULL backfill, no function rebuild", () => {
    expect(sql).not.toMatch(/drop\s+(column|table|constraint|function|policy|index)/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(sql).not.toMatch(/set\s+not\s+null/i);
  });

  it("does not touch RLS — new columns inherit the existing member-select policy", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table dream_candidates .*row level security/i);
  });

  it("documents the aggregate-only contract (no per-case note IDs persisted)", () => {
    expect(sql.toLowerCase()).toContain("aggregates only");
    expect(sql.toLowerCase()).toContain("no per-case note");
  });
});
