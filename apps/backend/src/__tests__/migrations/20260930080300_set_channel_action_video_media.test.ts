import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20260930080300_set_channel_action_video_media.sql"),
  "utf8",
);
const code = sql.replace(/--[^\n]*/g, "");
const fn = code.slice(code.indexOf("create or replace function set_channel_action_video_media"));
const successBranch = fn.slice(fn.indexOf("if p_ok then\n    update"), fn.indexOf("  else\n    update"));
const failureBranch = fn.slice(fn.indexOf("  else\n    update"), fn.indexOf("return jsonb_build_object('ok', true, 'executed', p_ok)"));

describe("20260930080300_set_channel_action_video_media", () => {
  it("is a pinned security definer callable only by service_role", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(code).toMatch(
      /revoke all on function set_channel_action_video_media\(uuid, uuid, uuid, uuid, boolean, jsonb, text, text\)\s+from public, anon, authenticated;/,
    );
    expect(code).toMatch(
      /grant execute on function set_channel_action_video_media\(uuid, uuid, uuid, uuid, boolean, jsonb, text, text\)\s+to service_role;/,
    );
    expect(code).not.toMatch(/grant execute on function set_channel_action_video_media[^;]*\b(anon|authenticated|public)\b/);
  });

  it("rejects a foreign-tenant action id as not_found, before any write", () => {
    const guard = fn.slice(fn.indexOf("select * into v_row"), fn.indexOf("v_owner :="));
    expect(guard).toMatch(/v_row\.tenant_id is distinct from p_tenant_id/);
    expect(guard).toMatch(/v_row\.run_id is distinct from p_run_id/);
    expect(guard).toMatch(/v_row\.exec_class is distinct from 'generated_video\.render\.v1'/);
    expect(guard).toMatch(/'code', 'not_found'/);
    expect(guard).not.toMatch(/\bupdate\s+channel_actions\b/);
  });

  it("only the claim owner may report success; a non-owner fails only after the lease", () => {
    expect(fn).toMatch(/v_row\.exec_claim_id = p_claim_id/);
    expect(fn).toMatch(/if p_ok then\s+return jsonb_build_object\('ok', false, 'code', 'not_owner'\)/);
    expect(fn).toMatch(/exec_claimed_at >= now\(\) - interval '10 minutes'/);
    expect(fn).toMatch(/if v_row\.exec_status is distinct from 'dispatching' then/);
  });

  it("refuses media outside the caller's tenant prefix or not a video", () => {
    expect(fn).toMatch(/p_media->>'kind' is distinct from 'video'/);
    expect(fn).toMatch(/not like \(p_tenant_id::text \|\| '\/%'\)/);
  });

  it("success writes the video onto the card and leaves the card open", () => {
    expect(successBranch).toMatch(/jsonb_set\(coalesce\(body, '\{\}'::jsonb\), '\{media\}', p_media, true\)/);
    expect(successBranch).toMatch(/exec_status = 'executed'/);
    expect(successBranch).not.toMatch(/\bstatus\s*=\s*'acted'/);
  });

  it("a failure can carry a whitelisted machine code into exec_result.code (the top-up link)", () => {
    expect(fn).toMatch(/p_code\s+text default null/);
    expect(fn).toMatch(/v_code\s+text := case when p_code ~ '\^\[a-z_\]\{1,40\}\$' then p_code else null end/);
    expect(failureBranch).toMatch(/jsonb_build_object\('code', v_code\)/);
  });

  it("failure settles exec_status failed and leaves the card's status pending (Try again)", () => {
    expect(failureBranch).toMatch(/exec_status = 'failed'/);
    expect(failureBranch).not.toMatch(/\bset\s+status\b|,\s*status\s*=/);
  });
});
