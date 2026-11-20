import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261020090000_free_edit_no_op_not_counted.sql";
const read = (f: string) => readFileSync(join(DIR, f), "utf-8");
const SQL = read(FILE);
const PRIOR = read("20261006090000_free_edits_and_first_goal_review.sql");

const fn = (src: string, name: string) => {
  const i = src.indexOf(`create or replace function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  return src.slice(i, src.indexOf("$$;", i));
};
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("20261020090000: a free edit that changes nothing does not use one up", () => {
  it("is the newest definition of _free_edits_used, or 20261024150000 which copies it and adds one condition", () => {
    const newest = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && read(f).includes("create or replace function _free_edits_used("))
      .sort()
      .at(-1);
    expect([FILE, "20261024150000_site_photos_and_free_photo_retry.sql"]).toContain(newest);
    const extra = "and not coalesce((c.goal_graph #>> '{0,payload,photo_retry}')::boolean, false) ";
    expect(squash(fn(read(newest!), "_free_edits_used")).replace(extra, "")).toBe(squash(fn(SQL, "_free_edits_used")));
  });

  it("keeps every condition of the 20261006090000 count", () => {
    const next = squash(fn(SQL, "_free_edits_used"));
    const prior = squash(fn(PRIOR, "_free_edits_used"));
    const where = prior.slice(prior.indexOf("where c.tenant_id = p_tenant_id"), prior.lastIndexOf("$$"));
    for (const clause of where.split(/ and (?![^()]*\))/)) expect(next).toContain(clause.trim());
  });

  it("skips only FINISHED no-op refines, at most 3 of them", () => {
    const next = squash(fn(SQL, "_free_edits_used"));
    expect(next).toContain("c.status = 'done' and coalesce((c.goal_graph #>> '{0,payload,no_change}')::boolean, false) as no_op");
    expect(next).toContain("greatest(0, (count(*) filter (where no_op)) - 3)");
    expect(SQL).toMatch(/revoke all on function _free_edits_used\(uuid, uuid\) from public, anon, authenticated;/);
  });
});
