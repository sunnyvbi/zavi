import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260905220000_conductor_failure_reason.sql"),
  "utf8",
);

const PRIOR = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260707120000_conductor_stale_slot_reap.sql"),
  "utf8",
);

const fnBody = (src: string): string => {
  const start = src.indexOf("create or replace function cancel_conductor_run(");
  const end = src.indexOf("revoke all on function cancel_conductor_run");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("20260905220000_conductor_failure_reason.sql", () => {
  it("adds both reason columns, nullable and additive", () => {
    expect(sql).toMatch(/alter table conductor_runs add column if not exists failure_reason text/i);
    expect(sql).toMatch(/alter table conductor_runs add column if not exists failure_class\s+text/i);
    expect(sql).not.toMatch(/update conductor_runs\s+set failure/i);
  });

  it("constrains failure_class to the existing BuildFailureClass vocabulary, NULL allowed", () => {
    expect(sql).toMatch(/conductor_runs_failure_class_check/);
    expect(sql).toMatch(/check \(failure_class is null or failure_class in \(/i);
    for (const member of [
      "stage_failed",
      "dispatch_failed",
      "provider_capacity",
      "repair_exhausted",
      "acceptance_failed",
      "deploy_failed",
      "budget_halted",
      "class_cap_halted",
      "stale_reaped",
      "user_cancelled",
      "unknown",
      "provision_failed",
      "coach_precedence",
    ]) {
      expect(sql).toContain(`'${member}'`);
    }
    expect(sql).not.toContain("'child_cancelled'");
  });

  it("does NOT touch the status CHECK — a new status value would break the money path", () => {
    expect(sql).not.toMatch(/conductor_runs_status_check/);
    expect(sql).not.toMatch(/add constraint[\s\S]{0,80}check \(status in/i);
    expect(sql).not.toMatch(/status\s*=\s*'cancelled'/);
    expect(fnBody(sql)).toMatch(/set status = 'failed'/);
  });

  it("persists the reason on the SAME atomic CAS update that flips the status", () => {
    const body = fnBody(sql);
    expect(body).toMatch(/set status = 'failed',[\s\S]*failure_class\s*=\s*v_failure_class/i);
    expect(body).toMatch(/failure_reason\s*=\s*v_failure_reason/i);
    expect(body).not.toMatch(/returning id into v_updated;[\s\S]{0,400}update conductor_runs\s+set failure/i);
  });

  it("maps the caller's p_reason vocabulary onto BuildFailureClass", () => {
    const body = fnBody(sql);
    expect(body).toMatch(/when 'user_cancel'\s+then 'user_cancelled'/);
    expect(body).toMatch(/when 'stale_slot_reap'\s+then 'stale_reaped'/);
    expect(body).toMatch(/when 'coach_precedence' then 'coach_precedence'/);
    expect(body).toMatch(/else 'unknown'/);
  });

  it("is a clean superset of the latest prior definition (DB-fn-rebuild gate)", () => {
    const prior = fnBody(PRIOR);
    const next = fnBody(sql);
    expect(next).toContain("p_require_updated_before  timestamptz default null");
    expect(next).toContain("and (p_require_updated_before is null or updated_at < p_require_updated_before)");
    expect(next).toContain("set stop_requested = true");
    expect(next).toContain("append_autopilot_action");
    expect(next).toContain("'kind', p_reason");
    expect(next).toContain("conductor_run_not_found");
    const INTENTIONALLY_REWRITTEN = [
      "language plpgsql security definer set search_path = public as $$",
      "set status = 'failed', updated_at = now()",
    ];
    const dropped = prior
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith("--"))
      .filter((l) => !next.includes(l));
    expect(dropped.sort()).toEqual([...INTENTIONALLY_REWRITTEN].sort());
    expect(next).toContain("set search_path = public, pg_temp");
    expect(next).toMatch(/set status = 'failed',\s*\n\s*updated_at = now\(\),/);
  });

  it("keeps pg_temp in search_path and re-asserts the grants after the replace", () => {
    expect(fnBody(sql)).toMatch(/set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function cancel_conductor_run\(uuid, uuid, text, timestamptz\) from public/i);
    expect(sql).toMatch(/revoke all on function cancel_conductor_run\(uuid, uuid, text, timestamptz\) from anon/i);
    expect(sql).toMatch(/revoke all on function cancel_conductor_run\(uuid, uuid, text, timestamptz\) from authenticated/i);
    expect(sql).toMatch(/grant execute on function cancel_conductor_run\(uuid, uuid, text, timestamptz\) to service_role/i);
  });
});
