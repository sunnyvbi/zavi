import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261008120000_team_notes.sql"),
  "utf8",
);
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const TABLES = ["team_note_offers", "team_note_judge_claims", "team_reports", "team_note_prefs"];
const TENANT_RPCS: Array<[string, string]> = [
  ["team_note_can_offer", "uuid, uuid, integer, integer, integer"],
  ["team_note_claim_judgement", "uuid, uuid, text, text\\[\\]"],
  ["team_note_offer", "uuid, uuid, text, text, text\\[\\], text, text"],
  ["team_note_mark_shown", "uuid, uuid, uuid, integer, integer, integer, integer"],
  ["team_note_send", "uuid, uuid, uuid, text, text, integer"],
  ["team_note_dismiss", "uuid, uuid, uuid, boolean"],
  ["team_note_mark_opened", "uuid, uuid, uuid"],
  ["team_note_set_suggestions", "uuid, uuid, boolean"],
];
const PRIVATE_HELPERS = [
  "_team_note_assert_member", "_team_note_message_ctx", "_team_note_cap_reason", "_team_note_merge_meta",
];

function body(fn: string): string {
  const start = sql.indexOf(`function public.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const rest = sql.slice(start);
  return rest.slice(0, rest.indexOf("$$;"));
}
function createTable(t: string): string {
  const s = sql.slice(sql.indexOf(`create table if not exists public.${t}`));
  return s.slice(0, s.indexOf("\n);"));
}

describe("20261008120000_team_notes.sql", () => {
  it("every table: RLS on, no write policy, even service_role only reads", () => {
    for (const t of TABLES) {
      expect(sql, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(sql, t).toMatch(new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`));
      expect(sql, t).not.toMatch(new RegExp(`create policy [a-z_]+\\s+on public\\.${t}\\s+(as [a-z]+\\s+)?for (insert|update|delete|all)`, "i"));
      expect(sql, t).toMatch(new RegExp(`revoke all on public\\.${t} from service_role;\\s*grant select on public\\.${t} to service_role`));
      expect(createTable(t), t).toMatch(/tenant_id\s+uuid not null references public\.tenants\(id\) on delete cascade/);
    }
  });

  it("team_reports: one permissive policy keyed on the creator + membership; restrictive active tenant", () => {
    const policies = sql.match(/create policy [a-z_]+\s+on public\.team_reports(?! as restrictive)[\s\S]*?;\n/g) ?? [];
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/user_id = \(select auth\.uid\(\)\)/);
    expect(policies[0]).toMatch(/tu\.tenant_id = team_reports\.tenant_id/);
    expect(sql).toMatch(/team_reports_active_tenant_restrict\s+on public\.team_reports as restrictive for select\s+using \(tenant_id = \(select public\.app_active_tenant\(\)\)\)/);
  });

  it("team_note_prefs: self + current membership; restrictive active tenant (R2)", () => {
    const p = sql.match(/create policy team_note_prefs_self_select[\s\S]*?;\n/)![0];
    expect(p).toMatch(/user_id = \(select auth\.uid\(\)\)/);
    expect(p).toMatch(/tu\.tenant_id = team_note_prefs\.tenant_id/);
    expect(sql).toMatch(/team_note_prefs_active_tenant_restrict\s+on public\.team_note_prefs as restrictive for select\s+using \(tenant_id = \(select public\.app_active_tenant\(\)\)\)/);
  });

  it("ledger and claims: no authenticated read at all, and no note text", () => {
    for (const t of ["team_note_offers", "team_note_judge_claims"]) {
      expect(sql, t).not.toMatch(new RegExp(`create policy [a-z_]+\\s+on public\\.${t}`));
      expect(sql, t).not.toMatch(new RegExp(`grant select[^;]*on public\\.${t} to authenticated`));
      expect(createTable(t), t).not.toMatch(/\bnote\b\s+text/);
    }
  });

  it("user deletes cascade; chat deletion nulls the report's links", () => {
    for (const t of ["team_note_offers", "team_reports", "team_note_prefs"]) {
      expect(createTable(t), t).toMatch(/user_id\s+uuid not null references auth\.users\(id\) on delete cascade/);
    }
    const r = createTable("team_reports");
    expect(r).toMatch(/thread_id\s+uuid references public\.agent_threads\(id\) on delete set null/);
    expect(r).toMatch(/message_id\s+uuid references public\.agent_thread_messages\(id\) on delete set null/);
    expect(sql).toMatch(/constraint team_note_offers_one_per_message unique \(message_id\)/);
  });

  it("every index on the ledger leads with tenant_id (R1)", () => {
    const idx = sql.match(/create index if not exists team_note_offers_[a-z_]+\s+on public\.team_note_offers \(([^)]*)\)/g) ?? [];
    expect(idx.length).toBeGreaterThanOrEqual(3);
    for (const i of idx.filter((x) => !/team_note_offers_purge\s/.test(x))) expect(i, i).toMatch(/\(tenant_id, /);
  });

  it("every RPC and helper is security definer, pinned search_path; RPCs service_role only; helpers never granted", () => {
    for (const [fn, sig] of TENANT_RPCS) {
      expect(body(fn), fn).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(${sig}\\) from public, anon, authenticated`));
      expect(sql, fn).toMatch(new RegExp(`grant execute on function public\\.${fn}\\(${sig}\\) to service_role`));
    }
    for (const fn of PRIVATE_HELPERS) {
      expect(body(fn), fn).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(sql, fn).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\(`));
    }
    expect(sql).toMatch(/revoke all on function public\.purge_expired_team_notes\(integer, integer\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.purge_expired_team_notes\(integer, integer\) to service_role/);
  });

  it("founder-facing RPCs check membership AND thread ownership against the actor", () => {
    for (const fn of ["team_note_mark_shown", "team_note_send", "team_note_dismiss", "team_note_mark_opened"]) {
      const b = body(fn);
      expect(b, fn).toMatch(/_team_note_assert_member\(p_tenant_id, p_actor\)/);
      expect(b, fn).toMatch(/v\.user_id is distinct from p_actor/);
    }
    expect(body("team_note_set_suggestions")).toMatch(/_team_note_assert_member\(p_tenant_id, p_actor\)/);
  });

  it("message context: tenant-pinned, returns the MATCHED run, refuses a run from another tenant (R4)", () => {
    const b = body("_team_note_message_ctx");
    expect(b).toMatch(/select m\.thread_id, t\.user_id, r\.id,/);
    expect(b).toMatch(/m\.id = p_message_id and m\.tenant_id = p_tenant_id and t\.tenant_id = p_tenant_id/);
    expect(b).toMatch(/and \(m\.agent_run_id is null or r\.id is not null\)/);
  });

  it("every offer-row read and write is tenant-checked (R4)", () => {
    const scoped = sql.slice(0, sql.indexOf("-- ── 7. retention purge"));
    const offerTouches = scoped.match(/(from|update) team_note_offers[\s\S]{0,400}?;/g) ?? [];
    expect(offerTouches.length).toBeGreaterThan(5);
    for (const t of offerTouches) expect(t, t).toMatch(/tenant_id = p_tenant_id/);
  });

  it("caps and streak are per tenant + user, count SHOWN strips only, rolling windows (R1)", () => {
    const c = body("_team_note_cap_reason");
    expect(c).toMatch(/tenant_id = p_tenant_id and thread_id = p_thread_id\s+and shown_at > now\(\) - make_interval\(hours => greatest\(p_thread_window_hours, 1\)\)/);
    expect(c).toMatch(/tenant_id = p_tenant_id and user_id = p_user_id and shown_at > now\(\) - interval '24 hours'/);
    expect(c).not.toMatch(/drafted_at >/);
    expect(body("team_note_mark_shown")).toMatch(/where tenant_id = p_tenant_id and user_id = v\.user_id and status in \('sent', 'dismissed'\)/);
  });

  it("drafting consumes no cap; showing enforces caps under a (tenant, user) lock (R1)", () => {
    expect(body("team_note_offer")).not.toMatch(/_team_note_cap_reason\(/);
    expect(body("team_note_offer")).toMatch(/_team_note_merge_meta\(p_message_id,/);
    const s = body("team_note_mark_shown");
    expect(s).toMatch(/pg_advisory_xact_lock\(hashtextextended\('team_note:' \|\| p_tenant_id::text \|\| ':' \|\| v\.user_id::text, 0\)\)/);
    expect(s).toMatch(/_team_note_cap_reason\(/);
    expect(s).toMatch(/status = 'suppressed'/);
  });

  it("one judgement per reply: claim is an insert-or-nothing keyed on message_id (R7)", () => {
    expect(createTable("team_note_judge_claims")).toMatch(/message_id\s+uuid primary key references public\.agent_thread_messages\(id\) on delete cascade/);
    expect(body("team_note_claim_judgement")).toMatch(/on conflict \(message_id\) do nothing/);
  });

  it("send and dismiss only act on a strip the founder was shown", () => {
    expect(body("team_note_send")).toMatch(/o\.status <> 'shown'/);
    expect(body("team_note_dismiss")).toMatch(/status = 'shown'/);
  });

  it("retention is clamped to 1..180 days in the database (R3)", () => {
    expect(body("team_note_send")).toMatch(/make_interval\(days => least\(greatest\(coalesce\(p_retention_days, 180\), 1\), 180\)\)/);
  });

  it("purge: bounded, SKIP LOCKED, reports backlog (R8)", () => {
    const b = body("purge_expired_team_notes");
    expect((b.match(/for update skip locked/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(b).toMatch(/'backlog'/);
    expect(b).toMatch(/'oldest_expired_seconds'/);
  });

  it("meta merge is a single atomic jsonb concat", () => {
    expect(body("_team_note_merge_meta")).toMatch(/set meta = coalesce\(meta, '\{\}'::jsonb\) \|\| p_patch/);
  });

  it("does not touch record_agent_chat_reply", () => {
    expect(sql).not.toMatch(/record_agent_chat_reply/);
  });

  it("tables and RPCs are classified in the tenant-isolation registry", () => {
    for (const t of TABLES) expect(registry, t).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    for (const [fn] of TENANT_RPCS) expect(registry, fn).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
  });
});
