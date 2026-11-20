import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const fn = (sql: string) => {
  const start = sql.indexOf("create or replace function set_channel_action(");
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
};
const norm = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
const before = fn(read("20260921140000_channel_action_event_history.sql"));
const sql = read("20260930050000_set_channel_action_cgo_source.sql");
const after = fn(sql);

describe("20260930050000_set_channel_action_cgo_source.sql", () => {
  it("logs a cgo event as 'system', a founder's as 'founder'", () => {
    expect(after).toMatch(/case when p_source = 'cgo' then 'system' else 'founder' end/);
  });

  it("refuses any other source, and a cgo call that names a user or does not close the card", () => {
    expect(after).toMatch(/p_source is not null and p_source is distinct from 'cgo'/);
    expect(after).toMatch(/p_source = 'cgo' and \(p_actor_user_id is not null or p_status not in \('acted', 'rejected'\)\)/);
  });

  it("is a strict superset of the latest earlier body", () => {
    const expected = norm(before)
      .replace("p_actor_user_id uuid default null ) returns jsonb", "p_actor_user_id uuid default null, p_source text default null ) returns jsonb")
      .replace(
        "(p_tenant_id, p_action_id, p_status, 'founder', p_actor_user_id, v_note, v_key,",
        "(p_tenant_id, p_action_id, p_status, case when p_source = 'cgo' then 'system' else 'founder' end, p_actor_user_id, v_note, v_key,",
      );
    const guard =
      "if p_source is not null and p_source is distinct from 'cgo' then return jsonb_build_object('ok', false, 'code', 'invalid_source'); end if; " +
      "if p_source = 'cgo' and (p_actor_user_id is not null or p_status not in ('acted', 'rejected')) then return jsonb_build_object('ok', false, 'code', 'invalid_source'); end if; ";
    const anchor = "return jsonb_build_object('ok', false, 'code', 'invalid_status'); end if; ";
    const withGuard = expected.replace(anchor, anchor + guard);
    expect(withGuard).not.toBe(norm(before));
    expect(norm(after)).toBe(withGuard);
  });

  it("drops the old signature, keeps security definer and service_role-only execute", () => {
    expect(sql).toMatch(/drop function if exists set_channel_action\(uuid, uuid, text, text, timestamptz, text, uuid\);/);
    expect(after).toMatch(/language plpgsql security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function set_channel_action\(uuid, uuid, text, text, timestamptz, text, uuid, text\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function set_channel_action\(uuid, uuid, text, text, timestamptz, text, uuid, text\)\s+to service_role;/);
    expect(sql).not.toMatch(/to (authenticated|anon)/);
  });
});
