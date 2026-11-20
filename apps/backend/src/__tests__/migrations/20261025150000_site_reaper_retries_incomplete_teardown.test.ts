import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261025150000_site_reaper_retries_incomplete_teardown.sql"), "utf8");
const prior = readFileSync(join(dir, "20261014100050_site_reaper_keeps_unpublished_builds.sql"), "utf8");
const body = (s: string) => s.slice(s.indexOf("begin;"));

describe("migration 20261025150000_site_reaper_retries_incomplete_teardown", () => {
  it("is the prior definition with only the deleting fallback widened to 'no provider left to delete'", () => {
    const expected = body(prior).replace(
      "                          where p.site_id = s.id and p.tenant_id = s.tenant_id)\n       ))",
      "                          where p.site_id = s.id and p.tenant_id = s.tenant_id\n                            and p.state <> 'deleted')\n       ))",
    );
    const strip = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(expected).not.toBe(body(prior));
    expect(strip(body(sql))).toBe(strip(expected));
  });

  it("stays service-role only", () => {
    expect(sql).toContain("revoke all on function public.site_reaper_candidates(timestamptz, int) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;");
  });
});
