import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const middlewareSrc = readFileSync(
  join(__dirname, "../../services/auth/staff-middleware.ts"),
  "utf-8",
);
const staffAccessSrc = readFileSync(
  join(__dirname, "../../services/auth/staff-model-access.ts"),
  "utf-8",
);
const jwtSrc = readFileSync(
  join(__dirname, "../../services/auth/jwt.ts"),
  "utf-8",
);
const runsRouteSrc = readFileSync(
  join(__dirname, "../../routes/admin/cross-tenant-runs.ts"),
  "utf-8",
);
const mig0068 = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0069_staff_access_log.sql",
  ),
  "utf-8",
);

describe("staff-middleware hardening (DB-is-the-gate — T-MULTI-ADMIN-1)", () => {
  it("uses customerJwksUrl() instead of STAFF_SUPABASE_JWKS_URL env", () => {
    expect(middlewareSrc).toMatch(/customerJwksUrl\(\)/);
    expect(middlewareSrc).not.toMatch(/process\.env\.STAFF_SUPABASE_JWKS_URL/);
  });

  it("uses customerExpectedIssuer() instead of STAFF_SUPABASE_EXPECTED_ISSUER env", () => {
    expect(middlewareSrc).toMatch(/customerExpectedIssuer\(\)/);
    expect(middlewareSrc).not.toMatch(
      /process\.env\.STAFF_SUPABASE_EXPECTED_ISSUER/,
    );
  });

  it("verifies expectedAudience='authenticated'", () => {
    expect(middlewareSrc).toMatch(/expectedAudience\s*[:=]\s*"authenticated"/);
  });

  it("gates on a LIVE staff_users read (revoked_at IS NULL), not app_metadata", () => {
    expect(middlewareSrc).toMatch(/await isActiveStaffUser\(serviceClient\(\), sub\)/);
    expect(staffAccessSrc).toMatch(/from\("staff_users"\)/);
    expect(staffAccessSrc).toMatch(/\.is\("revoked_at",\s*null\)/);
    expect(middlewareSrc).toMatch(/"not_staff"/);
    expect(middlewareSrc).not.toMatch(/appMeta\.role/);
  });

  it("no longer gates on the STAFF_EMAIL_ALLOWLIST env var", () => {
    expect(middlewareSrc).not.toMatch(/process\.env\.STAFF_EMAIL_ALLOWLIST/);
    expect(middlewareSrc).not.toMatch(/"staff_not_allowlisted"/);
    expect(middlewareSrc).not.toMatch(/env\.allowlist/);
  });

  it("FAILS CLOSED on a staff_users read error (503, never open)", () => {
    expect(middlewareSrc).toMatch(/staff_check_unavailable/);
    expect(middlewareSrc).toMatch(/\.status\(503\)/);
  });

  it("does NOT gate on email_verified (GoTrue never emits it top-level)", () => {
    expect(middlewareSrc).not.toMatch(/emailVerified/);
    expect(middlewareSrc).not.toMatch(/"email_not_verified"/);
  });

  it("normalizes email (trim + lowercase) for session + audit", () => {
    expect(middlewareSrc).toMatch(/\.trim\(\)\.toLowerCase\(\)/);
  });

  it("keeps the 500 staff_misconfigured path (SUPABASE_URL missing)", () => {
    expect(middlewareSrc).toMatch(/staff_misconfigured/);
    expect(middlewareSrc).toMatch(/\.status\(500\)/);
  });

  it("returns 401 with explicit codes for each auth failure mode", () => {
    expect(middlewareSrc).toMatch(/"unauthenticated"/);
    expect(middlewareSrc).toMatch(/"invalid_jwt"/);
    expect(middlewareSrc).toMatch(/"not_staff"/);
  });

  it("writes one staff_access_log row on every middleware hit (success + failure)", () => {
    expect(middlewareSrc).toMatch(/staff_access_log/);
    expect(middlewareSrc).toMatch(/recordAccess\(/);
    expect(middlewareSrc).toMatch(/void\s*\(async\s*\(\)/);
  });

  it("captures route, ip, ua on the audit row", () => {
    expect(middlewareSrc).toMatch(/function reqRoute/);
    expect(middlewareSrc).toMatch(/function reqIp/);
    expect(middlewareSrc).toMatch(/function reqUa/);
    expect(middlewareSrc).toMatch(/route\s*=\s*reqRoute\(req\)/);
    expect(middlewareSrc).toMatch(/ip\s*=\s*reqIp\(req\)/);
    expect(middlewareSrc).toMatch(/ua\s*=\s*reqUa\(req\)/);
    expect(middlewareSrc).toMatch(/recordAccess\(\{[^}]*route,\s*ip,\s*ua/);
  });

  it("keeps the _clearStaffEnvForTests test hook", () => {
    expect(middlewareSrc).toMatch(/export function _clearStaffEnvForTests/);
  });

  it("keeps the assertStaff belt-and-suspenders helper", () => {
    expect(middlewareSrc).toMatch(/export function assertStaff/);
  });
});

describe("jwt.ts exports for staff-middleware reuse (Track B)", () => {
  it("exports customerJwksUrl()", () => {
    expect(jwtSrc).toMatch(/export function customerJwksUrl\(\)/);
  });

  it("exports customerExpectedIssuer() derived from SUPABASE_URL", () => {
    expect(jwtSrc).toMatch(/export function customerExpectedIssuer\(\)/);
    expect(jwtSrc).toMatch(/auth\/v1/);
  });
});

describe("cross-tenant-runs ?stuck=1 filter (Track B B2)", () => {
  it("accepts ?stuck=1 query param", () => {
    expect(runsRouteSrc).toMatch(/req\.query\.stuck/);
  });

  it("uses last_progress_at column (not started_at) for the running leg", () => {
    expect(runsRouteSrc).toMatch(/last_progress_at/);
  });

  it("falls back to started_at when last_progress_at is NULL", () => {
    expect(runsRouteSrc).toMatch(
      /last_progress_at\.is\.null,started_at\.lt\./,
    );
  });

  it("uses 5-minute threshold for running rows (matches A0 watchdog)", () => {
    expect(runsRouteSrc).toMatch(/STUCK_RUNNING_MIN\s*=\s*5/);
  });

  it("uses 10-minute threshold for queued rows (matches QUEUED_STUCK_MIN)", () => {
    expect(runsRouteSrc).toMatch(/STUCK_QUEUED_MIN\s*=\s*10/);
  });

  it("includes inngest_run_id in the SELECT (for W3 detail deep-link)", () => {
    expect(runsRouteSrc).toMatch(/inngest_run_id/);
  });

  it("staffRunDetail SELECT includes last_progress_at + inngest_run_id + trigger", () => {
    expect(runsRouteSrc).toMatch(
      /staffRunDetail[\s\S]*?\.select\([^)]*last_progress_at[^)]*\)/,
    );
    expect(runsRouteSrc).toMatch(
      /staffRunDetail[\s\S]*?\.select\([^)]*inngest_run_id[^)]*\)/,
    );
    expect(runsRouteSrc).toMatch(
      /staffRunDetail[\s\S]*?\.select\([^)]*trigger[^)]*\)/,
    );
  });
});

describe("migration 0068 — staff_access_log audit table (Track B B3)", () => {
  it("creates the staff_access_log table", () => {
    expect(mig0068).toMatch(/create table if not exists staff_access_log/i);
  });

  it("has staff_user_id uuid nullable (failed-auth rows)", () => {
    expect(mig0068).toMatch(/staff_user_id uuid\s+null/i);
  });

  it("has email text nullable (failed-auth rows)", () => {
    expect(mig0068).toMatch(/email text\s+null/i);
  });

  it("has route text NOT NULL", () => {
    expect(mig0068).toMatch(/route text not null/i);
  });

  it("has ip + ua text columns (nullable)", () => {
    expect(mig0068).toMatch(/ip text\s+null/i);
    expect(mig0068).toMatch(/ua text\s+null/i);
  });

  it("has ts timestamptz NOT NULL DEFAULT now()", () => {
    expect(mig0068).toMatch(/ts timestamptz not null default now\(\)/i);
  });

  it("indexes ts desc for retention sweeps", () => {
    expect(mig0068).toMatch(
      /create index if not exists staff_access_log_ts on staff_access_log \(ts desc\)/i,
    );
  });

  it("enables row level security (no public read path)", () => {
    expect(mig0068).toMatch(
      /alter table staff_access_log enable row level security/i,
    );
  });

  it("references the Codex P1-D fix in the header comment", () => {
    expect(mig0068).toMatch(/P1-D|audit/i);
  });
});
