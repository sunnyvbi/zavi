import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260909180000_growth_plan_basis_evidence.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const OLD_SET_PLAN = /set_growth_plan\(uuid, text, text, text, text, text, text\)/i;
const NEW_SET_PLAN = /set_growth_plan\(uuid, text, text, text, text, jsonb, text, text\)/i;
const OLD_COMMIT = /commit_growth_plan\(uuid, text, text, text, text, jsonb, text, text\)/i;
const NEW_COMMIT =
  /commit_growth_plan\(uuid, text, text, text, text, jsonb, jsonb, text, text\)/i;

describe("20260909180000_growth_plan_basis_evidence.sql", () => {
  it("adds a nullable jsonb column — every existing plan predates it", () => {
    expect(code).toMatch(
      /alter table growth_plan\s+add column if not exists basis_evidence jsonb/i,
    );
    expect(code).not.toMatch(/basis_evidence jsonb\s+not null/i);
  });

  it("constrains SHAPE and SIZE only — provenance is not a SQL problem", () => {
    expect(code).toMatch(/jsonb_typeof\(basis_evidence\) = 'array'/i);
    expect(code).toMatch(/jsonb_array_length\(basis_evidence\) <= 24/i);
    expect(code).toMatch(/basis_evidence is null\s+or/i);
  });

  it("DROPS the old set_growth_plan arity before recreating it", () => {
    expect(code).toMatch(
      new RegExp(`drop function if exists ${OLD_SET_PLAN.source}`, "i"),
    );
    expect(code).toMatch(/create or replace function set_growth_plan\(/i);
  });

  it("DROPS the old commit_growth_plan arity before recreating it", () => {
    expect(code).toMatch(
      new RegExp(`drop function if exists ${OLD_COMMIT.source}`, "i"),
    );
    expect(code).toMatch(/create or replace function commit_growth_plan\(/i);
  });

  it("restores service_role execute on BOTH new signatures", () => {
    for (const sig of [NEW_SET_PLAN, NEW_COMMIT]) {
      expect(code).toMatch(
        new RegExp(`revoke all on function ${sig.source}\\s+from public, anon, authenticated`, "i"),
      );
      expect(code).toMatch(
        new RegExp(`grant execute on function ${sig.source}\\s+to service_role`, "i"),
      );
    }
  });

  it("never re-grants a dropped arity back into existence", () => {
    const grants = code.match(/grant execute on function [a-z_]+\([^)]*\)/gi) ?? [];
    for (const g of grants) {
      expect(g).not.toMatch(OLD_SET_PLAN);
      expect(g).not.toMatch(OLD_COMMIT);
    }
  });

  it("commit_growth_plan passes the evidence down to set_growth_plan", () => {
    const fn = code.slice(code.indexOf("create or replace function commit_growth_plan("));
    expect(fn).toMatch(/p_constraint_confidence, p_basis_evidence,/i);
  });

  it("stores null rather than aborting the accept on a non-array", () => {
    expect(code).toMatch(
      /case when jsonb_typeof\(p_basis_evidence\) = 'array' then p_basis_evidence else null end/i,
    );
  });

  it("does not log an evidence change per revision", () => {
    expect(code).not.toMatch(/'basis_evidence'[\s\S]{0,80}log_growth_plan_change/i);
  });
});
