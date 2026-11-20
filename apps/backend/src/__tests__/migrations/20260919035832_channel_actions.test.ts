import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260919035832_channel_actions.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const TABLES = ["channel_actions", "channel_action_events", "channel_metrics"];
const RPCS = [
  "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)",
  "set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid)",
  "mark_channel_action_redone(uuid, uuid, uuid, text)",
];
const esc = (s: string) => s.replace(/[()]/g, (c) => `\\${c}`);

describe("20260919035832_channel_actions.sql", () => {
  it.each(TABLES)("%s: RLS on, member SELECT + active-tenant RESTRICTIVE, no DML policy", (t) => {
    expect(code).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
    expect(code).toMatch(new RegExp(`create policy ${t}_member_select on ${t}\\s+for select`, "i"));
    expect(code).toMatch(
      new RegExp(`create policy ${t}_active_tenant_restrict\\s+on ${t} as restrictive for select`, "i"),
    );
    expect(code).not.toMatch(new RegExp(`on ${t}[^;]*for (insert|update|delete|all)`, "i"));
  });

  it("the view runs under the caller's RLS", () => {
    expect(code).toMatch(/create view channel_runs with \(security_invoker = true\)/i);
    expect(code).toMatch(/where r\.channel_slug is not null/i);
  });

  it("idempotency keys: one row per run slot, one event per key, one metric per day", () => {
    expect(code).toMatch(/unique \(run_id, position\)/i);
    expect(code).toMatch(/unique \(action_id, event_key\)/i);
    expect(code).toMatch(/unique \(tenant_id, channel_slug, metric_key, window_kind, day\)/i);
  });

  it("status and event vocabularies include stale / acted / stale_flagged", () => {
    expect(code).toMatch(/'pending','acted','rejected','snoozed','redone','stale'/);
    expect(code).toMatch(
      /'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',\s*'revised','approved','executed','exec_failed'\)/,
    );
  });

  it("reserves PR 2 / PR 3 columns as nullable, plus unique (tenant_id, id)", () => {
    for (const col of [
      "exec_class\\s+text,",
      "exec_payload\\s+jsonb,",
      "exec_status\\s+text check \\(exec_status in \\('queued','dispatching','executed','failed'\\)\\),",
      "exec_result\\s+jsonb,",
      "executed_at\\s+timestamptz,",
      "approved_by\\s+uuid,",
      "approved_by_source text,",
      "edited_body\\s+jsonb,",
    ]) {
      expect(code).toMatch(new RegExp(col));
    }
    expect(code).not.toMatch(/(exec_class|exec_payload|exec_status|edited_body|approved_by)\s+\w+[^,\n]*not null/i);
    expect(code).toMatch(/unique \(tenant_id, id\)/i);
  });

  it("nothing in this migration writes the reserved columns (no approve / execute logic yet)", () => {
    expect(code).not.toMatch(/set\s+exec_status\s*=/i);
    expect(code).not.toMatch(/set\s+edited_body\s*=/i);
    expect(code).not.toMatch(/approve_channel_action|record_channel_exec_action|channel_action_messages/i);
  });

  it("set_channel_action, redo and stale refuse to move an action whose execution is in flight", () => {
    expect(code).toMatch(/if v_row\.exec_status in \('queued', 'dispatching'\) then\s+return jsonb_build_object\('ok', false, 'code', 'exec_in_flight'/i);
    expect(code).toMatch(/if v_old\.exec_status in \('queued', 'dispatching'\) then\s+return jsonb_build_object\('ok', false, 'code', 'exec_in_flight'/i);
    expect(code).toMatch(/exec_status is distinct from 'queued'\s+and exec_status is distinct from 'dispatching'/i);
  });

  it("every RPC is security definer with search_path public, pg_temp", () => {
    const defs = code.match(/language plpgsql security definer set search_path = public, pg_temp/gi) ?? [];
    expect(defs).toHaveLength(3);
  });

  it.each(RPCS)("%s is revoked from public/anon/authenticated and granted to service_role only", (sig) => {
    expect(code).toMatch(new RegExp(`revoke all on function ${esc(sig)}\\s+from public, anon, authenticated`, "i"));
    expect(code).toMatch(new RegExp(`grant execute on function ${esc(sig)}\\s+to service_role`, "i"));
    expect(code).not.toMatch(new RegExp(`grant execute on function ${esc(sig)}[^;]*authenticated`, "i"));
  });

  it("record_channel_run_actions re-derives tenant + channel from agent_runs and fails closed", () => {
    expect(code).toMatch(/select tenant_id, channel_slug into v_tenant, v_channel\s+from agent_runs where id = p_run_id/i);
    expect(code).toMatch(/p_tenant_id is distinct from v_tenant then\s+raise exception/i);
    expect(code).toMatch(/'skipped_reason', 'unstamped_run'/);
  });

  it("stale only touches a pending/snoozed action of the same tenant + channel, with evidence", () => {
    expect(code).toMatch(
      /set status = 'stale'[\s\S]{0,200}tenant_id = v_tenant\s+and channel_slug = v_channel\s+and status in \('pending', 'snoozed'\)/i,
    );
    expect(code).toMatch(/v_evidence is not null/);
  });

  it("set_channel_action: another tenant's id reads as not_found; a replayed key is a no-op", () => {
    expect(code).toMatch(/v_row\.tenant_id is distinct from p_tenant_id then\s+return jsonb_build_object\('ok', false, 'code', 'not_found'\)/i);
    expect(code).toMatch(/'replayed', true/);
    expect(code).toMatch(/if v_row\.status not in \('pending', 'snoozed'\) then/i);
  });

  it("no age-based expiry anywhere", () => {
    expect(code).not.toMatch(/interval\s+'\d+ days?'/i);
    expect(code).not.toMatch(/expire/i);
  });
});
