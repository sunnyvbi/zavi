import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928200000_cgo_approval_source.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const cgoFn = code.slice(
  code.indexOf("create or replace function decide_decision_as_cgo"),
  code.indexOf("create or replace function approve_channel_action"),
);
const approveFn = code.slice(code.indexOf("create or replace function approve_channel_action"));

const RPCS = [
  "decide_decision_as_cgo(uuid, uuid, uuid, text)",
  "approve_channel_action(uuid, uuid, text, uuid, text)",
];
const esc = (s: string) => s.replace(/[()]/g, (c) => `\\${c}`);

describe("20260928200000_cgo_approval_source.sql", () => {
  it("both functions are security definer with search_path public, pg_temp", () => {
    const defs = code.match(/language plpgsql security definer set search_path = public, pg_temp/gi) ?? [];
    expect(defs).toHaveLength(RPCS.length);
    expect(cgoFn).toMatch(/security definer set search_path = public, pg_temp/i);
    expect(approveFn).toMatch(/security definer set search_path = public, pg_temp/i);
  });

  it.each(RPCS)("%s is revoked from public/anon/authenticated, service_role only", (sig) => {
    expect(code).toMatch(new RegExp(`revoke all on function ${esc(sig)}\\s+from public, anon, authenticated`, "i"));
    expect(code).toMatch(new RegExp(`grant execute on function ${esc(sig)}\\s+to service_role`, "i"));
    expect(code).not.toMatch(new RegExp(`grant execute on function ${esc(sig)}[^;]*(authenticated|anon)`, "i"));
  });

  it("decide_decision_as_cgo keeps the cross-tenant check", () => {
    expect(cgoFn).toMatch(
      /if v_tenant <> p_tenant_id then\s+raise exception 'cross_tenant: [^']*'/i,
    );
  });

  it("decide_decision_as_cgo requires the actor to be the tenant OWNER", () => {
    expect(cgoFn).toMatch(
      /from tenant_users\s+where user_id = p_actor_user_id and tenant_id = p_tenant_id and role = 'owner'/i,
    );
    expect(cgoFn).toMatch(/raise exception 'not_member: /i);
  });

  it("decide_decision_as_cgo only approves, and stamps approved_by_source = 'cgo'", () => {
    expect(cgoFn).toMatch(/if p_action is distinct from 'approve' then\s+raise exception/i);
    expect(cgoFn).toMatch(/approved_by_source = 'cgo'/i);
    expect(cgoFn).not.toMatch(/rejected_by/i);
    expect(cgoFn).not.toMatch(/approved_by_source\s*=\s*(null|'staff')/i);
  });

  it("decide_decision_as_cgo is a CAS that reports the real row count", () => {
    expect(cgoFn).toMatch(/where id = p_decision_id and status = 'proposed'/i);
    expect(cgoFn).toMatch(/get diagnostics v_rows = row_count/i);
    expect(cgoFn).toMatch(/if v_rows = 0 then[\s\S]{0,200}'changed', false/i);
  });

  it("approve_channel_action accepts exactly staff and cgo as sources, anything else refused", () => {
    expect(approveFn).toMatch(/p_source is not null and p_source not in \('staff', 'cgo'\)[\s\S]{0,120}'invalid_source'/i);
    expect(approveFn).toMatch(/approved_by_source = p_source/i);
  });

  it("approve_channel_action keeps the tenant and membership checks verbatim", () => {
    expect(approveFn).toMatch(/v_row\.tenant_id is distinct from p_tenant_id then\s+return jsonb_build_object\('ok', false, 'code', 'not_found'\)/i);
    expect(approveFn).toMatch(/'code', 'approver_required'/);
    expect(approveFn).toMatch(
      /from tenant_users tu\s+where tu\.tenant_id = p_tenant_id and tu\.user_id = p_actor_user_id/i,
    );
    expect(approveFn).toMatch(/if v_row\.exec_status in \('queued', 'dispatching'\) then/i);
  });

  it("a cgo channel approval is logged as 'system', never as the founder", () => {
    expect(approveFn).toMatch(/case when p_source = 'cgo' then 'system' else 'founder' end/i);
  });
});
