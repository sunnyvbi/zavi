import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260930010000_ad_ledger.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return src.slice(at, src.indexOf("$$;", src.indexOf("$$", at) + 2));
};
const TABLES = ["ad_campaigns", "ad_spend_daily", "ad_budget_plan"];

describe("20260930010000_ad_ledger", () => {
  it("sorts after every earlier migration", () => {
    expect(readdirSync(MIG_DIR)).toContain(FILE);
    expect(FILE > "20260929230000_session_pin_one_truth.sql").toBe(true);
  });

  it("the three tables: RLS on, members of the tenant read, nobody writes but the RPC", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toMatch(new RegExp(`create policy ${t}_member_select on public\\.${t}\\s+for select using`));
      expect(sql).toContain(`tu.user_id = auth.uid() and tu.tenant_id = ${t}.tenant_id`);
      expect(sql).toMatch(new RegExp(`${t}_active_tenant_restrict\\s+on public\\.${t} as restrictive for select`));
      expect(sql).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}[^;]*for (insert|update|delete|all)`));
      expect(sql).not.toMatch(new RegExp(`grant [^;]*(insert|update|delete|all)[^;]*on [^;]*public\\.${t}`));
    }
    const list = "public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan";
    expect(sql).toContain(`revoke all on ${list} from public, anon;`);
    expect(sql).toContain(`revoke insert, update, delete, truncate on ${list} from authenticated;`);
    expect(sql).toContain(`grant select on ${list} to authenticated;`);
    expect(sql).toContain(`revoke all on ${list} from service_role;`);
    expect(sql).toContain(`grant select on ${list} to service_role;`);
  });

  it("the unique keys the upserts and the plan rely on", () => {
    expect(sql).toContain("unique (tenant_id, platform, account_id, object_id)");
    expect(sql).toContain("unique (tenant_id, platform, account_id, object_id, spend_date, source)");
    expect(sql).toContain("unique (budget_id, month_start, platform)");
    expect(sql).toMatch(/amount_usd\s+numeric\(12,2\) not null check \(amount_usd >= 0\)/);
    expect(sql).toMatch(/planned_usd\s+numeric\(12,2\) not null check \(planned_usd >= 0\)/);
    expect(sql).toContain("check (reason is null or char_length(reason) <= 500)");
    expect(sql).toContain("budget_id     uuid not null references public.ad_budgets(id) on delete cascade");
  });

  it("the tables are classified in the tenant-isolation registry, the RPC in the tenant-RPC registry", () => {
    for (const t of TABLES) expect(registry).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    expect(registry).toMatch(/\n\s*record_ad_ledger_read: "p_tenant_id",/);
  });

  it("record_ad_ledger_read: security definer, pinned search_path, service-role only, validates before it writes", () => {
    const fn = fnOf(sql, "record_ad_ledger_read");
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    const sig = "uuid, text, text, jsonb, jsonb";
    expect(sql).toContain(`revoke all on function public.record_ad_ledger_read(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.record_ad_ledger_read(${sig}) to service_role;`);
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(fn).toContain("p_platform not in ('meta', 'google', 'reddit', 'tiktok')");
    expect(fn).toContain("'record_ad_ledger_read: invalid spend row'");
    expect(fn).toContain("(e->>'amount_usd')::numeric >= 0");
    expect(fn.lastIndexOf("raise exception")).toBeLessThan(fn.indexOf("insert into ad_campaigns"));
    expect(fn).toMatch(/select distinct on \(e\.value->>'object_id'\)\s+p_tenant_id, p_platform, p_account_id/);
    expect(fn).toMatch(/select p_tenant_id, p_platform, p_account_id, e->>'object_id'/);
    expect(fn).toContain("on conflict (tenant_id, platform, account_id, object_id, spend_date, source) do update");
    expect(fn).toContain("set amount_usd = excluded.amount_usd, recorded_at = excluded.recorded_at");
  });

  it("start_ad_budget_month: the rollover resets the month and no longer marks anything for pausing", () => {
    const now = fnOf(sql, "start_ad_budget_month");
    const prior = fnOf(readFileSync(join(MIG_DIR, "20260929010000_ad_budget_monthly.sql"), "utf8"), "start_ad_budget_month");
    expect(prior).toContain("set pause_due = true");
    expect(now).not.toContain("pause_due");
    expect(now).toMatch(/security definer set search_path = public, pg_temp/);
    const reset = /update ad_budgets\s+set month_start = v_month, spent_usd = 0, alarm_90_sent_at = null,\s+actual_read_at = null, month_note_sent_for = null, updated_at = now\(\)/;
    expect(prior).toMatch(reset);
    expect(now).toMatch(reset);
    expect(now).toContain("where id = p_budget_id and tenant_id = p_tenant_id\n   for update;");
    expect(now).toContain("'pause', '[]'::jsonb");
    expect(now).toContain("'paused_before', '[]'::jsonb");
    expect(now).toContain("'note_due', false");
    expect(sql).toContain("revoke all on function public.start_ad_budget_month(uuid, uuid) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.start_ad_budget_month(uuid, uuid) to service_role;");
    expect(sql).toMatch(/update public\.ad_budget_reservations\s+set pause_due = false, updated_at = now\(\)\s+where pause_due;/);
  });

  it("one transaction, nothing dropped", () => {
    expect(sql.trim().startsWith("--")).toBe(true);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trim().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop (function|table)/);
  });
});
