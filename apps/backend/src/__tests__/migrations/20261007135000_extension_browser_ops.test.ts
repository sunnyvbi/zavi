import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261007135000_extension_browser_ops.sql";
const raw = readFileSync(join(MIG_DIR, FILE), "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

function fnBody(name: string): string {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  expect(at, `${name} defined`).toBeGreaterThan(-1);
  return sql.slice(at, sql.indexOf("end $$;", at));
}
const squash = (s: string) => s.replace(/\s+/g, " ");

describe(FILE, () => {
  it("has a unique version that sorts after every earlier migration", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.startsWith("20261007135000_"))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBeGreaterThan(
      files.indexOf("20261007100000_ask_agent_paused_awaiting_child.sql"),
    );
  });

  it("both tables: RLS on, no policies, every client privilege revoked", () => {
    for (const t of ["extension_panel_sessions", "extension_browser_ops"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]* on (table )?public\.extension_(panel_sessions|browser_ops)/i);
  });

  it("an op can only point at a session of the SAME tenant and user (composite FK)", () => {
    expect(squash(sql)).toContain("unique (id, tenant_id, user_id)");
    expect(squash(sql)).toContain(
      "foreign key (panel_session_id, tenant_id, user_id) references public.extension_panel_sessions (id, tenant_id, user_id)",
    );
    expect(squash(sql)).toContain("unique (run_id, seq)");
  });

  it("status vocabulary is exactly the plan's", () => {
    expect(squash(sql)).toContain(
      "check (status in ( 'queued', 'delivered', 'lease_expired', 'done', 'failed', 'unknown', 'awaiting_confirm', 'expired' ))",
    );
  });

  it("both RPCs: security definer, pinned search_path, execute revoked from clients, service_role only", () => {
    const sigs = {
      claim_extension_op: "(uuid, uuid, uuid)",
      complete_extension_op: "(uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb)",
    };
    for (const [name, sig] of Object.entries(sigs)) {
      expect(squash(fnBody(name))).toContain("security definer set search_path = public, pg_temp");
      expect(sql).toContain(`revoke all on function public.${name}${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}${sig} to service_role;`);
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}[^;]*(anon|authenticated)`));
    }
  });

  it("claim: live session owned by (tenant, user) required before anything happens", () => {
    const b = squash(fnBody("claim_extension_op"));
    const gate = b.slice(b.indexOf("from public.extension_panel_sessions s"), b.indexOf("return;"));
    for (const p of [
      "s.id = p_session_id",
      "s.tenant_id = p_tenant_id",
      "s.user_id = p_user_id",
      "s.ended_at is null",
      "s.last_seen_at > now() - interval '30 seconds'",
    ]) {
      expect(gate, p).toContain(p);
    }
  });

  it("claim: locks the live session row so Stop serializes with the claim", () => {
    const b = squash(fnBody("claim_extension_op"));
    const gate = b.slice(b.indexOf("from public.extension_panel_sessions s"), b.indexOf("if not found"));
    expect(gate).toContain("for update");
  });

  it("claim: refuses when consent is revoked, locking the consent row against a concurrent revoke", () => {
    const b = squash(fnBody("claim_extension_op"));
    const c = b.slice(b.indexOf("from public.extension_consent c"));
    for (const p of ["c.tenant_id = p_tenant_id", "c.user_id = p_user_id", "c.revoked_at is null", "for share"]) {
      expect(c, p).toContain(p);
    }
    expect(b.indexOf("from public.extension_consent c")).toBeLessThan(b.indexOf("update public.extension_browser_ops"));
  });

  it("claim: lapsed WRITE → unknown, lapsed READ → lease_expired, scoped to the caller's session", () => {
    const b = squash(fnBody("claim_extension_op"));
    const sweep = b.slice(b.indexOf("update public.extension_browser_ops o set status = case"));
    const end = sweep.indexOf(";");
    const stmt = sweep.slice(0, end);
    expect(stmt).toContain("case when o.is_write then 'unknown' else 'lease_expired' end");
    for (const p of [
      "o.tenant_id = p_tenant_id",
      "o.user_id = p_user_id",
      "o.panel_session_id = p_session_id",
      "o.status = 'delivered'",
      "o.lease_until <= now()",
    ]) {
      expect(stmt, p).toContain(p);
    }
  });

  it("claim: picks only this (tenant, user, session)'s queued/lease_expired, unexpired op, skip-locked", () => {
    const b = squash(fnBody("claim_extension_op"));
    const pick = b.slice(b.indexOf("select o.id into v_id"), b.indexOf("for update skip locked;") + 23);
    for (const p of [
      "o.tenant_id = p_tenant_id",
      "o.user_id = p_user_id",
      "o.panel_session_id = p_session_id",
      "o.status in ('queued', 'lease_expired')",
      "o.expires_at > now()",
      "for update skip locked",
    ]) {
      expect(pick, p).toContain(p);
    }
    expect(pick).not.toContain("'unknown'");
    expect(b).toContain(
      "set status = 'delivered', execution_token = gen_random_uuid(), lease_until = now() + interval '15 seconds'",
    );
  });

  it("complete: every identity + token + live lease + live session must match", () => {
    const b = squash(fnBody("complete_extension_op"));
    expect(b).toContain("p_status not in ('done', 'failed')");
    const upd = b.slice(b.indexOf("update public.extension_browser_ops o"), b.indexOf("returning o.id into v_id"));
    for (const p of [
      "o.id = p_op_id",
      "o.tenant_id = p_tenant_id",
      "o.user_id = p_user_id",
      "o.panel_session_id = p_session_id",
      "o.run_id = p_run_id",
      "o.execution_token = p_token",
      "o.status = 'delivered'",
      "o.lease_until > now()",
      "s.id = p_session_id",
      "s.tenant_id = p_tenant_id",
      "s.user_id = p_user_id",
      "s.ended_at is null",
      "s.last_seen_at > now() - interval '30 seconds'",
    ]) {
      expect(upd, p).toContain(p);
    }
    expect(b).toContain("return v_id is not null;");
  });

  it("the tenant arg is injected by tenantRpc, and both tables are registered tenant-scoped", () => {
    expect(registry).toMatch(/^\s{2}claim_extension_op: "p_tenant_id",$/m);
    expect(registry).toMatch(/^\s{2}complete_extension_op: "p_tenant_id",$/m);
    expect(registry).toMatch(/^\s{2}extension_panel_sessions: "tenant_id",$/m);
    expect(registry).toMatch(/^\s{2}extension_browser_ops: "tenant_id",$/m);
  });
});
