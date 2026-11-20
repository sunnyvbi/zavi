import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "../../../../../supabase/migrations");

const remainingClasses = readFileSync(
  join(migrationsDir, "0042_remaining_decision_classes.sql"),
  "utf-8",
);
const defaultDeny = readFileSync(
  join(migrationsDir, "0043_emit_decision_default_deny.sql"),
  "utf-8",
);
const enqueueRejections = readFileSync(
  join(migrationsDir, "0044_enqueue_rejections.sql"),
  "utf-8",
);
const markPrMerged = readFileSync(
  join(migrationsDir, "0045_mark_pr_merged_rpc.sql"),
  "utf-8",
);
const seedSchedules = readFileSync(
  join(migrationsDir, "0046_seed_orchestrator_schedules.sql"),
  "utf-8",
);

describe("0042 — remaining decision_classes seed", () => {
  for (const slug of [
    "customer-support-inbox.send-reply",
    "supply-onboarding.action",
    "dispute-response.submit-evidence",
    "listing-quality.action",
    "payouts-recon.notify",
    "trust-safety.action",
  ]) {
    it(`seeds ${slug}`, () => {
      expect(remainingClasses).toMatch(new RegExp(`'${slug.replace(/[.]/g, "\\.")}'`));
    });
  }

  it("uses ON CONFLICT DO NOTHING (idempotent re-run)", () => {
    expect(remainingClasses).toMatch(/on conflict \(slug\) do nothing/);
  });

  it("default_autonomy is 'approval' for all (never 'auto' on money/comms classes)", () => {
    expect(remainingClasses).not.toMatch(/'auto'/);
  });
});

describe("0043 — emit_decision default-deny on unknown class", () => {
  it("raises exception when decision_class does not exist", () => {
    expect(defaultDeny).toMatch(/raise exception 'unknown decision_class:/);
  });

  it("uses check_violation errcode (23514) for caller distinguishability", () => {
    expect(defaultDeny).toMatch(/errcode = '23514'/);
  });
});

describe("0044 — enqueue_rejections audit table", () => {
  it("creates a standalone table (no FK to agent_runs since rejection is pre-row)", () => {
    expect(enqueueRejections).toMatch(/create table enqueue_rejections/);
    expect(enqueueRejections).not.toMatch(/references agent_runs/);
  });

  it("RLS-protected — tenant members read, service-role writes", () => {
    expect(enqueueRejections).toMatch(/enable row level security/);
    expect(enqueueRejections).toMatch(/revoke insert, update, delete on enqueue_rejections from authenticated/);
    expect(enqueueRejections).toMatch(/grant select on enqueue_rejections to authenticated/);
  });

  it("fingerprints body via md5 (no raw payload — Codex C14)", () => {
    expect(enqueueRejections).toMatch(/body_fingerprint text/);
  });
});

describe("0045 — mark_pr_merged + agent_run_set_pr_meta RPCs", () => {
  it("mark_pr_merged is idempotent (only updates rows where merged is null)", () => {
    expect(markPrMerged).toMatch(
      /and \(parsed->>'merged' is null or parsed->>'merged' = 'false'\)/,
    );
  });

  it("mark_pr_merged scopes by tenant_id (cross-tenant defense)", () => {
    expect(markPrMerged).toMatch(/where tenant_id = p_tenant_id/);
  });

  it("agent_run_set_pr_meta writes pr_url + pr_repo + pr_number to parsed", () => {
    expect(markPrMerged).toMatch(/'pr_url', p_pr_url/);
    expect(markPrMerged).toMatch(/'pr_repo', p_pr_repo/);
    expect(markPrMerged).toMatch(/'pr_number', p_pr_number/);
  });
});

describe("0046 — seed orchestrator schedules", () => {
  it("seeds product-pm with daily 9am cron (historical text)", () => {
    expect(seedSchedules).toMatch(/'product-pm', '0 9 \* \* \*'/);
  });

  it("seeds fleet-auditor with weekly Monday 10am cron", () => {
    expect(seedSchedules).toMatch(/'fleet-auditor', '0 10 \* \* 1'/);
  });

  it("idempotent via ON CONFLICT DO NOTHING (re-run safe)", () => {
    expect(seedSchedules).toMatch(/on conflict \(tenant_id, agent_slug\) do nothing/);
  });
});
