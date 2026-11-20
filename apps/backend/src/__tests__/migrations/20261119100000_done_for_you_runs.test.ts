import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf-8");
const SQL = read("20261119100000_done_for_you_runs.sql");
const PRIOR = read("20261021094500_site_vision_fix_free.sql");
const fn = (src: string, name: string) => {
  const i = src.indexOf(`create or replace function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  return src.slice(i, src.indexOf("$$;", i));
};

const ADMIT = `
                 or _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                                         NEW.enqueued_by, NEW.cron_dedupe_key)`;
const SKIP = `
  -- A done-for-you run is paid by Zavi: no reserve, so finalize never charges.
  if _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                          NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;`;
describe("20261119100000 done-for-you runs (credit triggers)", () => {
  it.each([
    ["_trg_reserve_run_credits", ADMIT, SKIP],
    ["_trg_rereserve_run_credits", ADMIT, SKIP],
  ])("%s is the 20261021094500 body plus exactly the admission and the early return", (name, admit, skip) => {
    const next = fn(SQL, name);
    expect(next.split(admit).length - 1).toBe(1);
    expect(next.split(skip).length - 1).toBe(1);
    expect(next.replace(admit, "").replace(skip, "")).toBe(fn(PRIOR, name));
    expect(next.indexOf(skip)).toBeLessThan(next.indexOf("perform reserve_run_credits("));
  });

  it("is the newest definition of both triggers", () => {
    for (const name of ["_trg_reserve_run_credits", "_trg_rereserve_run_credits"]) {
      const newest = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql") && read(f).includes(`create or replace function ${name}(`))
        .sort()
        .at(-1);
      expect(newest, name).toBe("20261119100000_done_for_you_runs.sql");
    }
  });

  it("the identity is the service role's channel_recipe row under its OWN tenant's 1..3 key, granted to service_role only", () => {
    const f = fn(SQL, "_is_done_for_you_identity");
    expect(f).toMatch(/p_enqueued_by is null/);
    expect(f).toMatch(/p_trigger is not distinct from 'channel_recipe'/);
    expect(f).toMatch(/'done-for-you:' \|\| p_tenant_id::text \|\| ':3'/);
    expect(f).not.toMatch(/':4'/);
    expect(fn(SQL, "_is_done_for_you_run")).toMatch(/_tier_required\(p_agent_slug\) = 'starter'/);
    for (const sig of [
      "_is_done_for_you_identity(uuid, text, uuid, text)",
      "_is_done_for_you_run(uuid, text, text, uuid, text)",
      "claim_done_for_you_settle(uuid, uuid, text)",
      "claim_done_for_you_dispatch(uuid, uuid)",
    ]) {
      expect(SQL).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function ${sig} to service_role;`);
    }
  });
});
