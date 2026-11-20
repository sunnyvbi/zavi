import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261014100050_site_reaper_keeps_unpublished_builds.sql";
const PRIOR = "20261012130100_site_reaper_failed_claim.sql";
const SQL = readFileSync(join(DIR, FILE), "utf-8");

const stripComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function fnOf(source: string): string {
  const code = stripComments(source);
  const start = code.indexOf("create or replace function public.site_reaper_candidates(");
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf("end $$;", start);
  return norm(code.slice(start, end + "end $$;".length));
}

const EXCLUSION =
  "and not ( s.status = 'building' and exists (select 1 from public.conductor_runs r where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id and r.status = 'done') )";

describe("site_reaper_candidates keeps unpublished finished builds (20261014100050)", () => {
  it("is the 20261012130100 definition plus one exclusion, every live rail kept", () => {
    const before = fnOf(readFileSync(join(DIR, PRIOR), "utf-8"));
    const after = fnOf(SQL);
    expect(after).toBe(before.replace(" order by s.updated_at", ` ${EXCLUSION} order by s.updated_at`));
    for (const rail of ["s.live_sha is not null", "or s.live_deploy_id is not null"]) expect(after).toContain(rail);
  });

  it("stays security definer, pinned search_path, service_role only", () => {
    expect(fnOf(SQL)).toContain("language plpgsql security definer set search_path = pg_catalog, pg_temp as $$");
    expect(SQL).toContain("revoke all on function public.site_reaper_candidates(timestamptz, int) from public, anon, authenticated;");
    expect(SQL).toContain("grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;");
  });

  it("is the definition in force; a later redefinition keeps the live rails and the exclusion", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    const definers = files.filter((f) => stripComments(readFileSync(join(DIR, f), "utf-8")).includes("create or replace function public.site_reaper_candidates("));
    expect(definers[definers.length - 1] >= FILE).toBe(true);
    for (const later of definers.filter((f) => f > FILE)) {
      const fn = fnOf(readFileSync(join(DIR, later), "utf-8"));
      expect(fn).toContain("s.live_sha is not null");
      expect(fn).toContain(EXCLUSION);
    }
  });
});
