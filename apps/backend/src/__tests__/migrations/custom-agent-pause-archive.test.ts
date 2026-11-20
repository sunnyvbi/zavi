import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const NEW_FILE = "20260929140000_custom_agent_pause_archive.sql";
const PRIOR_FILE = "20260927220000_custom_agent_schedules.sql";

const fnBody = (src: string, name: string): string => {
  const start = src.indexOf(`create or replace function ${name}(`);
  const end = src.indexOf("end $$;", start);
  expect(start, name).toBeGreaterThan(-1);
  return src.slice(start, end + "end $$;".length);
};
const withoutAdded = (body: string) =>
  body
    .split("\n")
    .filter((l) => !/^\s+paused_(at|by)\s+=/.test(l))
    .join("\n");

describe(NEW_FILE, () => {
  const sql = read(NEW_FILE);
  const prior = read(PRIOR_FILE);

  for (const fn of ["set_custom_agent_status", "record_custom_agent_outcome"]) {
    it(`${fn} is the prior body plus only the paused_at / paused_by lines`, () => {
      expect(withoutAdded(fnBody(sql, fn))).toBe(fnBody(prior, fn));
      expect(fnBody(sql, fn)).toMatch(/paused_at\s+=/);
    });

    it(`${fn}: no later migration re-defines it`, () => {
      const later = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql") && f > NEW_FILE)
        .filter((f) => new RegExp(`create or replace function (public\\.)?${fn}\\(`).test(read(f)));
      expect(later).toEqual([]);
    });
  }

  it("a member pause stamps who and when; resume/archive clears them; the auto-pause stamps no person", () => {
    const st = fnBody(sql, "set_custom_agent_status");
    expect(st).toMatch(/paused_by\s+= case when p_status = 'paused' then auth\.uid\(\) else null end/);
    const rec = fnBody(sql, "record_custom_agent_outcome");
    expect(rec).toMatch(/paused_by\s+= case when v_pause then null else paused_by end/);
  });

  it("set_custom_agent_status still refuses every change to an archived agent", () => {
    expect(fnBody(sql, "set_custom_agent_status")).toMatch(/and status <> 'archived'/);
  });

  it("unarchive: archived -> paused only, triggers back on, name clash -> custom_agent_name_taken, member-authorized", () => {
    const un = fnBody(sql, "unarchive_custom_agent");
    expect(un.indexOf("_custom_agent_check_name(p_tenant_id, v_norm, p_reserved_names, p_agent_id)")).toBeGreaterThan(-1);
    expect(un.indexOf("_custom_agent_check_name")).toBeLessThan(un.indexOf("status        = 'paused'"));
    expect(un).toMatch(/perform _custom_agent_authorize\(p_tenant_id\)/);
    expect(un).toMatch(/status\s+= 'paused'/);
    expect(un).not.toMatch(/status\s+= 'active'/);
    expect(un).toMatch(/and status = 'archived'/);
    expect(un).toMatch(/exception when unique_violation then\s+raise exception 'custom_agent_name_taken'/);
    expect(un).toMatch(/update custom_agent_triggers set enabled = true/);
    expect(sql).toMatch(/revoke all on function unarchive_custom_agent\(uuid, uuid, text\[\]\) from public, anon, authenticated;/);
  });
});
