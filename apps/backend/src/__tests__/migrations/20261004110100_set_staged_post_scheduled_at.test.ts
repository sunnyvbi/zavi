import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20261004110100_set_staged_post_scheduled_at.sql"),
  "utf8",
);
const code = sql.replace(/--[^\n]*/g, "");
const fn = code.slice(code.indexOf("create or replace function set_staged_post_scheduled_at"));
const SIG = "set_staged_post_scheduled_at\\(uuid, uuid, timestamptz, uuid\\)";

describe("20261004110100_set_staged_post_scheduled_at", () => {
  it("is a pinned security definer callable only by service_role", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(code).toMatch(new RegExp(`revoke all on function ${SIG}\\s+from public, anon, authenticated;`));
    expect(code).toMatch(new RegExp(`grant execute on function ${SIG} to service_role;`));
    expect(code).not.toMatch(/grant execute on function set_staged_post_scheduled_at[^;]*\b(anon|authenticated|public)\b/);
  });

  it("locks the row and refuses a foreign tenant, another class or a non-member before any write", () => {
    const guard = fn.slice(fn.indexOf("select * into v_row"), fn.indexOf("if v_row.status is distinct from"));
    expect(guard).toMatch(/from decisions where id = p_decision_id for update/);
    expect(guard).toMatch(/v_row\.tenant_id is distinct from p_tenant_id/);
    expect(guard).toMatch(/v_row\.decision_class is distinct from 'social\.publish\.v2'/);
    expect(guard).toMatch(/tu\.tenant_id = p_tenant_id and tu\.user_id = p_actor_user_id/);
    expect(guard).toMatch(/'code', 'not_found'/);
    expect(guard).not.toMatch(/\bupdate\s+decisions\b/);
    expect(fn).toMatch(/p_actor_user_id is null then\s+return jsonb_build_object\('ok', false, 'code', 'not_found'\)/);
  });

  it("moves only a pending proposal, and writes only body.scheduled_at", () => {
    expect(fn).toMatch(/v_row\.status is distinct from 'proposed' or v_row\.superseded_at is not null/);
    expect(fn).toMatch(/'code', 'not_pending'/);
    const write = fn.slice(fn.indexOf("update decisions"), fn.indexOf("where id = p_decision_id;", fn.indexOf("update decisions")));
    expect(write).toMatch(/set body = jsonb_set\(coalesce\(body, '\{\}'::jsonb\), '\{scheduled_at\}', v_at, true\)/);
    expect(write).not.toMatch(/\b(status|approved_\w+|decision_class|tenant_id)\s*=/);
  });
});
