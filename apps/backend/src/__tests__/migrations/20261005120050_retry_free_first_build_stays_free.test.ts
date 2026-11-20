import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261005120050_retry_free_first_build_stays_free.sql";
const read = (f: string) => readFileSync(join(DIR, f), "utf-8");
const SQL = read(FILE);
const PRIOR = read("20261003170000_retry_failed_build_in_place.sql");

const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

function latest(fn: string): { file: string; def: string } {
  const re = new RegExp(`create or replace function ${fn}\\(`);
  const file = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && re.test(read(f)))
    .sort()
    .at(-1)!;
  const sql = stripComments(read(file));
  const start = sql.search(re);
  return { file, def: sql.slice(start, sql.indexOf("$$;", start)) };
}

const body = (sql: string) => {
  const s = stripComments(sql);
  return s.slice(s.indexOf("create or replace function continue_paused_build("), s.indexOf("end $$;"));
};
const setClause = (sql: string) => {
  const b = body(sql);
  const at = b.indexOf("update conductor_runs");
  return b.slice(at, b.indexOf("where id = p_run_id", at));
};

describe("a retry of a failed free first build stays free (20261005120050)", () => {
  it("every later definition of continue_paused_build still leaves credits_waived alone", () => {
    const { file, def } = latest("continue_paused_build");
    expect(file >= FILE).toBe(true);
    expect(def).not.toMatch(/credits_waived/);
    expect(def).toMatch(/set status = 'active'/);
  });

  it("the resume leaves credits_waived as it was, so a free build stays free and a paid build stays paid", () => {
    expect(setClause(SQL)).not.toMatch(/credits_waived/);
    expect(setClause(SQL)).toMatch(/set status = 'active'/);
  });

  it("the resume leaves spend_usd and max_usd alone, so the lifetime budget still counts the failed attempt", () => {
    expect(setClause(SQL)).not.toMatch(/spend_usd|max_usd/);
  });

  it("changes nothing else from 20261003170000: same lock, supersede rule, running-build rule, retryable classes and grants", () => {
    const norm = (s: string) => body(s).replace(/\s+/g, " ");
    expect(norm(SQL)).toBe(
      norm(PRIOR).replace(", credits_waived = case when status = 'failed' then false else credits_waived end", ""),
    );
    expect(SQL).toMatch(/security definer set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) to service_role;/);
    expect(SQL).not.toMatch(/grant execute[^;]*to (public|anon|authenticated)/);
  });

  it("free first build failed then retried: its stages still skip the credit reserve (waived and active)", () => {
    const free = latest("_is_free_build_stage");
    expect(free.file).toBe("20260923120000_first_build_free.sql");
    expect(free.def).toMatch(/c\.credits_waived\s+and c\.status in \('provisioning', 'active'\)\)\s+where p_enqueued_by is null/);
    for (const trg of ["_trg_reserve_run_credits", "_trg_rereserve_run_credits"]) {
      const { file, def: d } = latest(trg);
      expect(
        ["20261019120000_brief_journey_fix_free.sql", "20261021094500_site_vision_fix_free.sql", "20261119100000_done_for_you_runs.sql"],
        trg,
      ).toContain(file);
      const skip = d.search(
        /if _is_free_build_stage\(NEW\.tenant_id, NEW\.payload, NEW\.trigger, NEW\.enqueued_by\) then\s+return null;\s+end if;/,
      );
      expect(skip, trg).toBeGreaterThan(-1);
      expect(skip, trg).toBeLessThan(d.indexOf("perform reserve_run_credits("));
      expect(d.match(/perform reserve_run_credits\(/g)?.length, trg).toBe(1);
    }
  });

  it("paid build failed then retried: not waived, so its stages take a reserve and are charged", () => {
    const writers = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /credits_waived\s*=\s*true/.test(stripComments(read(f))));
    expect(writers).toEqual([
      "20260923120000_first_build_free.sql",
      "20261006090000_free_edits_and_first_goal_review.sql",
      "20261024150000_site_photos_and_free_photo_retry.sql",
    ]);
    expect(latest("claim_photo_retry").def).toMatch(/set credits_waived = true[\s\S]*and status = 'provisioning'/);
    expect(latest("claim_free_edit").def).toMatch(/set credits_waived = true[\s\S]*and status = 'provisioning'/);
    expect(latest("claim_first_free_build").def).toMatch(
      /set credits_waived = true[\s\S]*and status = 'provisioning'/,
    );
  });

  it("the budget cap still applies to a free retry: the lifetime charge ignores the waiver", () => {
    const cap = latest("consume_conductor_budget_or_reject").def;
    expect(cap).not.toMatch(/credits_waived/);
    expect(cap).toMatch(/and \(max_usd is null or spend_usd \+ p_estimate_usd <= max_usd\)/);
  });
});
