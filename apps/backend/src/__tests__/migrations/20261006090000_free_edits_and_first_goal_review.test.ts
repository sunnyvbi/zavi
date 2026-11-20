import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261006090000_free_edits_and_first_goal_review.sql";
const read = (f: string) => readFileSync(join(DIR, f), "utf-8");
const SQL = read(FILE);
const PRIOR = read("20260926120000_custom_agents.sql");

const fn = (src: string, name: string) => {
  const i = src.indexOf(`create or replace function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  return src.slice(i, src.indexOf("$$;", i));
};

const SKIP = `  -- A tenant's first cgo goal review is paid by Zavi: no reserve, no charge.
  if _is_first_goal_review(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                           NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
`;

describe("20261006090000: first goal review on the house (credit triggers)", () => {
  it.each(["_trg_reserve_run_credits", "_trg_rereserve_run_credits"])(
    "%s is the 20260926120000 body plus exactly the first-review skip, before the only reserve",
    (name) => {
      const next = fn(SQL, name);
      expect(next.split(SKIP).length - 1).toBe(1);
      expect(next.replace(SKIP, "")).toBe(fn(PRIOR, name));
      expect(next.indexOf(SKIP)).toBeLessThan(next.indexOf("perform reserve_run_credits("));
      expect(next.match(/perform reserve_run_credits\(/g)?.length).toBe(1);
    },
  );

  it("is the newest definition of both triggers, or 20261019120000 which copies them verbatim and keeps this skip", () => {
    for (const name of ["_trg_reserve_run_credits", "_trg_rereserve_run_credits"]) {
      const newest = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql") && read(f).includes(`create or replace function ${name}(`))
        .sort()
        .at(-1);
      expect(
        ["20261019120000_brief_journey_fix_free.sql", "20261021094500_site_vision_fix_free.sql", "20261119100000_done_for_you_runs.sql"],
        name,
      ).toContain(newest);
      expect(read(newest!), name).toMatch(/if _is_first_goal_review\(NEW\.tenant_id, NEW\.agent_slug, NEW\.trigger,\s+NEW\.enqueued_by, NEW\.cron_dedupe_key\) then\s+return null;/);
    }
  });

  it("only the service role's a2a cgo run under the tenant's OWN first-review key is free (first not debited, later ones are)", () => {
    const f = fn(SQL, "_is_first_goal_review");
    expect(f).toMatch(/p_enqueued_by is null/);
    expect(f).toMatch(/p_trigger is not distinct from 'a2a'/);
    expect(f).toMatch(/p_agent_slug is not distinct from 'cgo'/);
    expect(f).toMatch(/p_cron_dedupe_key = p_tenant_id::text \|\| ':cgo-first-review'/);
    expect(f).not.toMatch(/like/i);
    expect(SQL).toMatch(/revoke all on function _is_first_goal_review\(uuid, text, text, uuid, text\) from public, anon, authenticated;/);
  });
});

describe("20261006090000: free edits", () => {
  it("Free is the canonical tier, only while credits are enforced and the tenant is not unlimited", () => {
    const f = fn(SQL, "_free_edits_apply");
    expect(f).toMatch(/_tenant_tier\(p_tenant_id\) = 'free'/);
    expect(f).toMatch(/_credits_enforced\(p_tenant_id\)/);
    expect(f).toMatch(/not _credits_unlimited\(p_tenant_id\)/);
  });

  it("counts waived refines that dispatched or are in flight, and not retries of a free edit", () => {
    const f = fn(SQL, "_free_edits_used");
    expect(f).toMatch(/c\.credits_waived/);
    expect(f).toMatch(/refine_mode/);
    expect(f).toMatch(/not _is_waived_refine\(/);
    expect(f).toMatch(/c\.status in \('provisioning', 'active'\)/);
    expect(f).toMatch(/a\.payload->>'build_conductor_run_id' = c\.id::text/);
  });

  it("the claim takes the build lock, allows 2, and only marks a provisioning refine row of the tenant", () => {
    const f = fn(SQL, "claim_free_edit");
    const lock = f.indexOf("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(f.indexOf("_free_edits_used("));
    expect(f).toMatch(/_free_edits_used\(p_tenant_id, p_conductor_run_id\) >= 2 then\s+return false;/);
    expect(f).toMatch(
      /set credits_waived = true, updated_at = now\(\)\s+where id = p_conductor_run_id\s+and tenant_id = p_tenant_id\s+and kind = 'build_app'\s+and status = 'provisioning'\s+and objective like '\[refine\]%'/,
    );
    expect(fn(SQL, "free_edit_state")).toMatch(/'limit', 2/);
  });

  it("the new RPCs are service-role only and pin pg_temp", () => {
    for (const sig of ["free_edit_state(uuid, uuid)", "claim_free_edit(uuid, uuid, uuid)"]) {
      expect(SQL).toContain(`revoke all on function ${sig}`);
      expect(SQL).toContain(`grant execute on function ${sig}`);
    }
    expect(SQL).not.toMatch(/grant execute[^;]*to (public|anon|authenticated)/);
    const defs = SQL.match(/create or replace function[\s\S]*?\$\$/g) ?? [];
    for (const d of defs) expect(d).toMatch(/security definer set search_path = public, pg_temp/);
  });
});

describe("20261114200000: one free retry of a first review that never started", () => {
  const RETRY = read("20261114200000_first_goal_review_free_retry.sql");
  const OLD_KEY = "     and p_cron_dedupe_key = p_tenant_id::text || ':cgo-first-review'\n";
  const NEW_KEY = `     and p_cron_dedupe_key in (
       p_tenant_id::text || ':cgo-first-review',
       p_tenant_id::text || ':cgo-first-review:retry'
     )
`;

  it("rebuilds _is_first_goal_review from its only prior definition, changing just the key test", () => {
    expect(fn(RETRY, "_is_first_goal_review")).toBe(fn(SQL, "_is_first_goal_review").replace(OLD_KEY, NEW_KEY));
  });

  it("is the newest definition of _is_first_goal_review, keeps the grants, and redefines no trigger", () => {
    const newest = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && read(f).includes("create or replace function _is_first_goal_review("))
      .sort()
      .at(-1);
    expect(newest).toBe("20261114200000_first_goal_review_free_retry.sql");
    expect(RETRY).toMatch(/revoke all on function _is_first_goal_review\(uuid, text, text, uuid, text\) from public, anon, authenticated;/);
    expect(RETRY).toMatch(/grant execute on function _is_first_goal_review\(uuid, text, text, uuid, text\) to service_role;/);
    expect(RETRY).not.toMatch(/create or replace function _trg_/);
  });
});
