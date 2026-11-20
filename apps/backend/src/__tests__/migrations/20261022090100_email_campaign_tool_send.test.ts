import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXEC_STAGES } from "@/services/channels/exec-progress";
import { NEVER_AUTO_DECISION_CLASSES } from "../../../workers/functions/dispatch-decision";
import { AUTOPILOT_SEND_SPACING_DAYS, EMAIL_SEND_EXEC_CLASSES } from "@/services/growth/unattended-email";

const FILE = "20261022090100_email_campaign_tool_send.sql";
const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations", FILE), "utf8");
const strip = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const norm = (s: string) => strip(s).replace(/\s+/g, " ").trim();
const fn = (name: string) => {
  const i = sql.indexOf(`create or replace function ${name}(`);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$$", i);
  return norm(sql.slice(i, sql.indexOf("$$;", open + 2) + 3));
};
const CLASS = EMAIL_SEND_EXEC_CLASSES[0];

describe(FILE, () => {
  it("progress: only the claim holding a dispatching row writes it, and a stage never goes backwards", () => {
    const body = fn("record_channel_action_exec_progress");
    expect(body).toContain(`array[${EXEC_STAGES.map((s) => `'${s}'`).join(", ")}]`);
    expect(body).toContain("select * into v_row from channel_actions where id = p_action_id for update;");
    expect(body).toContain("if not found or v_row.tenant_id is distinct from p_tenant_id then return jsonb_build_object('ok', false, 'code', 'not_found');");
    expect(body).toContain("if v_row.exec_status is distinct from 'dispatching' or v_row.exec_claim_id is null or v_row.exec_claim_id is distinct from p_claim_id then return jsonb_build_object('ok', false, 'code', 'not_owner');");
    expect(body).toContain("if v_rank < v_old_rank then return jsonb_build_object('ok', false, 'code', 'stage_backwards');");
    const reset = body.indexOf("if v_old_rank < 3 and v_row.exec_progress->>'campaign_id' is distinct from v_campaign then v_old_rank := 0; end if;");
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThan(body.indexOf("if v_rank < v_old_rank then"));
    expect(body).toContain("if v_old_rank >= 3 and v_row.exec_progress->>'campaign_id' is distinct from v_campaign then");
  });

  it("reconcile: one class, a row with progress, and only an unknown outcome or an expired lease", () => {
    const body = fn("reconcile_channel_action_exec");
    expect(body).toContain("select * into v_row from channel_actions where id = p_action_id for update;");
    expect(body).toContain("if not found or v_row.tenant_id is distinct from p_tenant_id then");
    expect(body).toContain(`if v_row.exec_class is distinct from '${CLASS}' then`);
    expect(body).toContain("if nullif(v_row.exec_progress->>'campaign_id', '') is null then");
    expect(body).toContain("v_unknown := coalesce(v_row.exec_status = 'failed' and v_row.exec_result->>'code' = 'exec_outcome_unknown', false);");
    expect(body).toContain("v_dead := coalesce(v_row.exec_status = 'dispatching' and (v_row.exec_claimed_at is null or v_row.exec_claimed_at < now() - interval '10 minutes'), false);");
    expect(body).toContain("if not (v_unknown or v_dead) then return jsonb_build_object('ok', false, 'code', 'not_unknown'");
    expect(body).toContain("perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_result);");
    expect(body).toContain("status = case when status in ('pending', 'snoozed') then 'acted' else status end");
    expect(body).not.toMatch(/status = 'pending'|then 'pending'/);
  });

  it("cgo approval: lock on tenant + tool + list, the 7-day check, then the unchanged approve, in one function", () => {
    const body = fn("approve_email_campaign_send_as_cgo");
    expect(body).toContain(`if v_row.exec_class is distinct from '${CLASS}' then`);
    const lock = body.indexOf("perform pg_advisory_xact_lock( hashtextextended('cgo_email_send:' || p_tenant_id::text || ':' || v_tool || ':' || v_audience, 0));");
    const check = body.indexOf("if exists ( select 1 from channel_actions c");
    const approve = body.indexOf("return approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(approve).toBeGreaterThan(check);
    expect(body).not.toContain("connected_account_id");
    expect(body).toContain("c.tenant_id = p_tenant_id and c.id <> p_action_id");
    expect(body).toContain("c.approved_by_source = 'cgo'");
    expect(body).toContain("c.exec_payload->>'tool' = v_tool and c.exec_payload->>'audience_id' = v_audience");
    const window = `interval '${AUTOPILOT_SEND_SPACING_DAYS} days'`;
    expect(body).toContain(`(c.exec_status = 'executed' and c.executed_at >= now() - ${window})`);
    expect(body).toContain("c.exec_status = 'queued'");
    expect(body).toContain(`(c.exec_status = 'failed' and c.exec_progress->>'stage' in ('send_requested', 'sent') and c.exec_claimed_at >= now() - ${window})`);
    expect(body).toContain("return jsonb_build_object('ok', false, 'code', 'cgo_email_sent_recently');");
  });

  it("every new function is security definer with a pinned search_path, and callable by the service role only", () => {
    for (const [name, sig] of [
      ["record_channel_action_exec_progress", "(uuid, uuid, uuid, jsonb)"],
      ["reconcile_channel_action_exec", "(uuid, uuid, boolean, jsonb, text)"],
      ["approve_email_campaign_send_as_cgo", "(uuid, uuid, text, uuid)"],
    ]) {
      expect(fn(name), name).toMatch(/security definer set search_path = public, pg_temp as \$\$/);
      expect(norm(sql), name).toContain(`revoke all on function ${name}${sig} from public, anon, authenticated;`);
      expect(norm(sql), name).toContain(`grant execute on function ${name}${sig} to service_role;`);
    }
    expect(norm(sql)).not.toMatch(/grant execute on function [^;]* to [^;]*(authenticated|anon)/);
  });

  it("the chat decision class is approval-only and never_auto, mirrored in the worker", () => {
    expect(norm(sql)).toMatch(new RegExp(`\\('${CLASS.replace(".", "\\.")}', '[^']*(?:''[^']*)*', 'approval', '${CLASS.replace(".", "\\.")}', true, false, 'high'\\)`));
    expect(NEVER_AUTO_DECISION_CLASSES.has(CLASS)).toBe(true);
  });
});
