import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const fn = (sql: string) => {
  const start = sql.indexOf("create or replace function settle_channel_action_exec(");
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
};
const before = fn(read("20260919060402_channel_action_exec.sql"));
const sql = read("20260928220000_settle_channel_action_exec_cgo_actor.sql");
const after = fn(sql);

describe("20260928220000_settle_channel_action_exec_cgo_actor.sql", () => {
  it("logs 'executed' as 'system' for a cgo approval, 'founder' otherwise", () => {
    expect(after).toMatch(/case when v_row\.approved_by_source = 'cgo' then 'system' else 'founder' end/);
    expect(after).not.toMatch(/'executed', 'founder'/);
  });

  it("changes nothing else: the body equals the earlier one with only that insert rewritten", () => {
    const norm = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
    const expected = norm(before).replace(
      "'executed', 'founder', v_row.approved_by, v_row.run_id, v_note, v_key",
      "'executed', case when v_row.approved_by_source = 'cgo' then 'system' else 'founder' end, v_row.approved_by, v_row.run_id, v_note, v_key",
    );
    expect(expected).not.toBe(norm(before));
    expect(norm(after)).toBe(expected);
  });

  it("keeps security definer, the pinned search_path, and service_role-only execute", () => {
    expect(after).toMatch(/language plpgsql security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(
      /revoke all on function settle_channel_action_exec\(uuid, uuid, boolean, jsonb, text, uuid\)\s+from public, anon, authenticated;/,
    );
    expect(sql).toMatch(/grant execute on function settle_channel_action_exec\(uuid, uuid, boolean, jsonb, text, uuid\)\s+to service_role;/);
    expect(sql).not.toMatch(/to (authenticated|anon)/);
  });
});
