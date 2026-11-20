
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261105190000_imessage_chat_surface.sql"), "utf-8");

function body(fn: string): string {
  const start = sql.indexOf(`create or replace function ${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("end $$;", start));
}

describe("20261105190000_imessage_chat_surface.sql", () => {
  it("keys a thread on (line, handle) so one person on one line is one tenant", () => {
    expect(sql).toMatch(/constraint imessage_threads_identity_unique unique \(line, handle\)/);
  });

  it("consume refuses another tenant's LIVE row, clears only one it let go of, and never reassigns tenant_id", () => {
    const b = body("consume_imessage_link_token");
    const guard = b.slice(b.indexOf("v_existing_tenant <> v_row.tenant_id then"), b.indexOf("if v_existing_status = 'enabled'"));
    expect(guard).toMatch(
      /v_existing_status = 'deleted'\s+or \(v_existing_status = 'pending' and v_existing_expires is not null and v_existing_expires <= now\(\)\)/,
    );
    expect(guard).toMatch(/delete from imessage_threads where line = p_line and handle = p_handle/);
    expect(guard).toMatch(/else\s+return 'owned_by_other_tenant'/);
    expect(b).not.toMatch(/update imessage_threads[^;]*tenant_id/);
    expect(b).toMatch(/values \(\s*v_row\.tenant_id, p_line, p_handle, 'pending'/);
    const conflict = b.slice(b.indexOf("on conflict (line, handle) do update"));
    const conflictSet = conflict.slice(0, conflict.indexOf("where imessage_threads.tenant_id = excluded.tenant_id"));
    expect(conflictSet.length).toBeGreaterThan(0);
    expect(conflictSet).not.toMatch(/tenant_id\s*=/);
    expect(conflictSet).not.toMatch(/'enabled'/);
    expect(conflict).toMatch(/if not found then\s+return 'owned_by_other_tenant'/);
  });

  it("confirm checks the tenant's newest pending row only, caps attempts, and takes no handle", () => {
    expect(sql).toMatch(/create or replace function confirm_imessage_bind\(\s*p_tenant_id uuid,\s*p_confirm_code text\s*\)/);
    const b = body("confirm_imessage_bind");
    expect(b).toMatch(/where tenant_id = p_tenant_id and status = 'pending'/);
    expect(b).toMatch(/for update/);
    expect(b).toMatch(/where tenant_id = p_tenant_id and status = 'pending'(\s*--[^\n]*)*\s+order by updated_at desc\s+limit 1\s+for update;/);
    expect(b).not.toMatch(/order by \(/);
    expect(b.indexOf("if v_attempts >= 5")).toBeGreaterThan(-1);
    expect(b.indexOf("if v_attempts >= 5")).toBeLessThan(b.indexOf("'bad_code'"));
  });

  it("removing one thread is scoped to tenant + id and keeps the identity as a tombstone", () => {
    const b = body("unset_imessage_thread");
    expect(b).toMatch(/where id = p_thread_id\s+and tenant_id = p_tenant_id/);
    expect(b).toMatch(/set status = 'deleted'/);
    expect(b).not.toMatch(/delete from imessage_threads/);
  });

  it("grants every RPC to service_role only", () => {
    const fns = [...sql.matchAll(/create or replace function (\w+)\(/g)].map((x) => x[1]!);
    for (const fn of fns) {
      expect(sql, fn).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\) from public, anon, authenticated;`));
      if (fn !== "_is_engineer_backend_run") {
        expect(sql, fn).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role;`));
      }
    }
    expect(sql).not.toMatch(/to (anon|authenticated)\b/);
  });

  it("only widens the trigger CHECKs: every earlier value stays admitted", () => {
    const prior = readFileSync(join(dir, "20260902191000_agent_runs_channel_recipe_trigger.sql"), "utf-8");
    const list = (s: string, name: string) => {
      const m = new RegExp(`constraint ${name}\\s+check \\(trigger in \\(([^)]*)\\)\\)`).exec(s);
      expect(m, name).not.toBeNull();
      return m![1]!.split(",").map((v) => v.trim());
    };
    const before = list(prior, "agent_runs_trigger_check");
    const after = list(sql, "agent_runs_trigger_check");
    expect(after).toEqual([...before, "'imessage'"]);
    expect(list(sql, "memory_signal_trigger_chk")).toContain("'imessage'");
  });
});
