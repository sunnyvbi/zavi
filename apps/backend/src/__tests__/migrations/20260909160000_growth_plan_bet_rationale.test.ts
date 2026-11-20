import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260909160000_growth_plan_bet_rationale.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const NEW_SIG =
  /set_growth_plan_bet\(uuid, uuid, uuid, text, text, text, text, text, text, text, int, text, text\)/i;
const OLD_SIG =
  /set_growth_plan_bet\(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text\)/i;

describe("20260909160000_growth_plan_bet_rationale.sql", () => {
  it("adds a nullable rationale column — existing bets predate it", () => {
    expect(code).toMatch(
      /alter table growth_plan_bets\s+add column if not exists rationale text/i,
    );
    expect(code).not.toMatch(/add column if not exists rationale text\s+not null/i);
    expect(code).not.toMatch(/add column if not exists rationale text\s+default/i);
  });

  it("DROPS the old 12-arg set_growth_plan_bet before recreating it", () => {
    expect(code).toMatch(
      /drop function if exists set_growth_plan_bet\(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text\)/i,
    );
    expect(code).toMatch(/create or replace function set_growth_plan_bet\(/i);
  });

  it("recreates set_growth_plan_bet with the 13-arg signature", () => {
    const fn = code.slice(
      code.indexOf("create or replace function set_growth_plan_bet("),
    );
    expect(fn).toMatch(/p_rationale\s+text/i);
    expect(fn).toMatch(/rationale\s*=\s*coalesce\(p_rationale, rationale\)/i);
  });

  it("restores the service_role grant it revoked, on the NEW signature", () => {
    expect(code).toMatch(
      new RegExp(`revoke all on function ${NEW_SIG.source}\\s+from public, anon, authenticated`, "i"),
    );
    expect(code).toMatch(
      new RegExp(`grant execute on function ${NEW_SIG.source}\\s+to service_role`, "i"),
    );
    const grants = code.match(/grant execute on function set_growth_plan_bet\([^)]*\)/gi) ?? [];
    for (const g of grants) expect(g).not.toMatch(OLD_SIG);
  });

  it("passes the rationale through commit_growth_plan without changing its signature", () => {
    const fn = code.slice(
      code.indexOf("create or replace function commit_growth_plan("),
    );
    expect(fn).not.toMatch(/p_rationale/i);
    expect(fn).toMatch(/nullif\(trim\(v_bet->>'rationale'\), ''\)/i);
  });

  it("does not backfill — a bet accepted without a reason keeps none", () => {
    expect(code).not.toMatch(/update growth_plan_bets\s+set rationale/i);
  });
});
