import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
function mig(substr: string): string {
  const f = readdirSync(MIG_DIR).find((x) => x.includes(substr));
  if (!f) throw new Error(`migration not found: ${substr} in ${MIG_DIR}`);
  return readFileSync(join(MIG_DIR, f), "utf8");
}

describe("S1 — credit read-helper grant hygiene", () => {
  const sql = mig("credit_grant_hygiene_allowance_enforced");
  it("revokes client EXECUTE on _credit_allowance_for_tenant + both _credits_enforced overloads", () => {
    expect(sql).toMatch(/revoke all on function _credit_allowance_for_tenant\(uuid\) from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function _credits_enforced\(\)\s+from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function _credits_enforced\(uuid\)\s+from public, anon, authenticated/);
  });
});

describe("S2 — finalize_run_credits atomic idempotency", () => {
  const sql = mig("finalize_run_credits_atomic_idempotency");
  it("inserts the terminal ledger row with returning-1 BEFORE mutating the balance (no pre-lock exists() race)", () => {
    expect(sql).toMatch(/on conflict \(run_id\) where kind in \('settle','refund'\) do nothing\s*\n\s*returning 1 into v_inserted/);
    expect(sql).toMatch(/if v_inserted is null then\s*\n\s*return 'noop'/);
    expect(sql.indexOf("for update")).toBeLessThan(sql.indexOf("returning 1 into v_inserted"));
  });
  it("keeps the $0.0025 settle peg", () => {
    expect(sql).toMatch(/ceil\(p_cost_usd \/ 0\.0025\)/);
  });
});

describe("S3 — finalize trigger always releases the hold", () => {
  const sql = mig("finalize_trigger_release_hold_always");
  it("gates the release on (enforced OR an open reserve exists), not enforcement alone", () => {
    expect(sql).toMatch(/if not _credits_enforced\(NEW\.tenant_id\)\s*\n\s*and not exists \(/);
    expect(sql).toMatch(/r\.kind = 'reserve'/);
  });
  it("widens OLD.status to include blocked (blocked-reap leak fix)", () => {
    expect(sql).toMatch(/OLD\.status in \('queued','running','blocked'\)/);
  });
});

describe("S4 — attempt-keyed metering for infra-retry", () => {
  const sql = mig("credit_ledger_attempt_keyed_infra_retry");
  it("adds the attempt column + re-keys the unique indexes to (run_id, attempt)", () => {
    expect(sql).toMatch(/add column if not exists attempt int not null default 0/);
    expect(sql).toMatch(/drop index if exists tcl_run_reserve_uq/);
    expect(sql).toMatch(/drop index if exists tcl_run_terminal_uq/);
    expect(sql).toMatch(/unique index if not exists tcl_run_attempt_reserve_uq\s*\n?\s*on tenant_credit_ledger \(run_id, attempt\) where kind = 'reserve'/);
    expect(sql).toMatch(/unique index if not exists tcl_run_attempt_terminal_uq\s*\n?\s*on tenant_credit_ledger \(run_id, attempt\) where kind in \('settle','refund'\)/);
  });
  it("re-reserve trigger fires ONLY on a terminal→queued transition (boot running→queued excluded)", () => {
    const start = sql.indexOf("function _trg_rereserve_run_credits()");
    const body = sql.slice(start, sql.indexOf("drop trigger if exists trg_agent_runs_rereserve_credits"));
    expect(body).toMatch(/OLD\.status in \('success','parse_failed','error','failed','cancelled','dispatch_error'\)\s*\n\s*and NEW\.status = 'queued'/);
    expect(body).not.toMatch(/OLD\.status in \('queued','running'\)/);
  });
  it("finalize discovers the OPEN reserve dynamically (not keyed off infra_retry_count)", () => {
    expect(sql).toMatch(/where r\.run_id = p_run_id and r\.kind = 'reserve'\s*\n\s*and not exists \(/);
    expect(sql).toMatch(/order by r\.attempt asc\s*\n\s*limit 1/);
    const fStart = sql.indexOf("function finalize_run_credits(");
    const fBody = sql.slice(fStart, sql.indexOf("-- ── (4)"));
    expect(fBody).not.toMatch(/infra_retry_count/i);
  });
  it("reserve_run_credits gains the p_attempt arity and drops the old 4-arg signature", () => {
    expect(sql).toMatch(/drop function if exists reserve_run_credits\(uuid, uuid, text, int\)/);
    expect(sql).toMatch(/function reserve_run_credits\(\s*\n?\s*p_tenant_id\s+uuid,\s*\n?\s*p_run_id\s+uuid,\s*\n?\s*p_agent_slug text,\s*\n?\s*p_estimate\s+int,\s*\n?\s*p_attempt\s+int/);
  });
});

describe("S7 — build-vs-universal mutual exclusion (preserves P0 membership gate)", () => {
  const sql = mig("enqueue_build_credit_universal_exclusion");
  it("skips the build charge when universal credits are enforced for the tenant", () => {
    expect(sql).toMatch(/v_enforce := \(p_agent_slug = 'engineer'\)\s*\n\s*and not _credits_enforced\(p_tenant_id\)/);
  });
  it("PRESERVES the unconditional cross-tenant membership gate from 20260628170000 (no security regression)", () => {
    expect(sql).toMatch(/if auth\.uid\(\) is not null and not exists \(/);
    expect(sql).toMatch(/raise exception 'not a member of tenant %'/);
  });
});

describe("S5/S6 — Stripe grant/revoke under a monotonic event watermark", () => {
  const s5 = mig("credit_grant_event_watermark_guard");
  const s6 = mig("revoke_tenant_credits_refund_dispute");
  it("S5 set_tenant_monthly_credits(uuid,int,bigint) GRANTS only on a strictly-newer event (codex P2.a)", () => {
    expect(s5).toMatch(/add column if not exists monthly_credits_event bigint not null default 0/);
    expect(s5).toMatch(/function set_tenant_monthly_credits\(\s*\n?\s*p_tenant_id uuid, p_monthly_credits int, p_event_created bigint/);
    expect(s5).toMatch(/p_event_created > monthly_credits_event/);
    expect(s5).not.toMatch(/p_event_created >= monthly_credits_event/);
  });
  it("S5 backfills the credit watermark from the existing stripe_event_created (codex P1.b)", () => {
    expect(s5).toMatch(/set monthly_credits_event = stripe_event_created\s*\n\s*where stripe_event_created > monthly_credits_event/);
  });
  it("S6 revoke clears the override AND resets plan='free' under the SAME monotonic watermark (codex P1.a)", () => {
    expect(s6).toMatch(/function revoke_tenant_credits\(\s*\n?\s*p_tenant_id uuid, p_event_created bigint/);
    expect(s6).toMatch(/monthly_credits\s+= null/);
    expect(s6).toMatch(/plan\s+= 'free'/);
    expect(s6).toMatch(/p_event_created >= monthly_credits_event/);
  });
});

describe("2026-07-01 — durable refund block + subscription-scoped revoke", () => {
  const sql = mig("credits_p1_refund_block_and_scoped_revoke");

  it("adds the durable credits_revoked_at block column", () => {
    expect(sql).toMatch(/add column if not exists credits_revoked_at timestamptz/);
  });

  it("set_tenant_monthly_credits FREEZES all credit writes while the tenant is revoked (P1 #1)", () => {
    const setStart = sql.indexOf("function set_tenant_monthly_credits(");
    const setEnd = sql.indexOf("function revoke_tenant_credits(");
    const setBody = sql.slice(setStart, setEnd);
    expect(setBody).toMatch(/and credits_revoked_at is null/);
    expect(setBody).not.toMatch(/p_monthly_credits <= 0 or credits_revoked_at is null/);
    expect(setBody).toMatch(/p_event_created > monthly_credits_event/);
    expect(sql).toMatch(/drop function if exists set_tenant_monthly_credits\(uuid, int\)/);
  });

  it("revoke is SCOPED to the granting subscription and stamps the durable block (P1 #1 + #2)", () => {
    expect(sql).toMatch(/drop function if exists revoke_tenant_credits\(uuid, bigint\)/);
    expect(sql).toMatch(
      /function revoke_tenant_credits\(\s*\n?\s*p_tenant_id uuid, p_event_created bigint, p_stripe_subscription_id text/,
    );
    expect(sql).toMatch(/stripe_subscription_id = p_stripe_subscription_id/);
    expect(sql).toMatch(/p_stripe_subscription_id is not null/);
    expect(sql).toMatch(/grandfathered = false/);
    expect(sql).toMatch(/monthly_credits\s+= 0/);
    expect(sql).toMatch(/credits_revoked_at\s+= now\(\)/);
    expect(sql).toMatch(/p_event_created >= monthly_credits_event/);
    const revStart = sql.indexOf("function revoke_tenant_credits(");
    const revEnd = sql.indexOf("clear_credit_revocation");
    expect(sql.slice(revStart, revEnd)).not.toMatch(/plan\s+= 'free'/);
  });

  it("provides clear_credit_revocation as the human unblock path (service_role only)", () => {
    expect(sql).toMatch(/function clear_credit_revocation\(/);
    expect(sql).toMatch(/set credits_revoked_at = null/);
    expect(sql).toMatch(/floor\(extract\(epoch from now\(\)\)\)::bigint/);
    expect(sql).toMatch(
      /grant execute on function clear_credit_revocation\(uuid, int, bigint\) to service_role/,
    );
    expect(sql).toMatch(
      /revoke all on function clear_credit_revocation\(uuid, int, bigint\) from public, anon, authenticated/,
    );
  });
});
