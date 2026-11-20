import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20261004110050_set_channel_action_publish_on.sql"),
  "utf8",
);
const code = sql.replace(/--[^\n]*/g, "");
const fn = code.slice(code.indexOf("create or replace function set_channel_action_publish_on"));

describe("20261004110050_set_channel_action_publish_on", () => {
  it("is a pinned security definer callable only by service_role", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(code).toMatch(
      /revoke all on function set_channel_action_publish_on\(uuid, uuid, date, uuid\)\s+from public, anon, authenticated;/,
    );
    expect(code).toMatch(/grant execute on function set_channel_action_publish_on\(uuid, uuid, date, uuid\) to service_role;/);
    expect(code).not.toMatch(/grant execute on function set_channel_action_publish_on[^;]*\b(anon|authenticated|public)\b/);
  });

  it("rejects a foreign-tenant id and a non-member actor as not_found, before any write", () => {
    const guard = fn.slice(fn.indexOf("select * into v_row"), fn.indexOf("if v_row.status not in"));
    expect(guard).toMatch(/v_row\.tenant_id is distinct from p_tenant_id/);
    expect(guard).toMatch(/tu\.tenant_id = p_tenant_id and tu\.user_id = p_actor_user_id/);
    expect(guard).toMatch(/'code', 'not_found'/);
    expect(guard).not.toMatch(/\bupdate\s+channel_actions\b/);
  });

  it("moves only an open card, and writes only body.step.publish_on", () => {
    expect(fn).toMatch(/if v_row\.status not in \('pending', 'snoozed'\) then/);
    const write = fn.slice(fn.indexOf("update channel_actions"), fn.indexOf("where id = p_action_id;"));
    expect(write).toMatch(/set body = case/);
    expect(write).toMatch(/body #- '\{step,publish_on\}'/);
    expect(write).toMatch(/jsonb_set\(body, '\{step,publish_on\}'/);
    expect(write).not.toMatch(/\b(status|title|exec_\w+|edited_body)\s*=/);
  });
});
