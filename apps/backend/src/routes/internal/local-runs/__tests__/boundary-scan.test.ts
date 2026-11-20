import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = __dirname;
const handlersSrc = readFileSync(join(HERE, "../handlers.ts"), "utf-8");
const authSrc = readFileSync(join(HERE, "../auth.ts"), "utf-8");
const routesIndexSrc = readFileSync(
  join(HERE, "../../../index.ts"),
  "utf-8",
);
const migrationSrc = readFileSync(
  join(
    HERE,
    "../../../../../../../supabase/migrations/20260607090000_mac_worker_tokens.sql",
  ),
  "utf-8",
);

describe("local-runs mount is token-gated", () => {
  it("the router applies macWorkerAuth before any handler", () => {
    const useIdx = handlersSrc.indexOf("r.use(macWorkerAuth)");
    const firstPostIdx = handlersSrc.indexOf("r.post(");
    expect(useIdx).toBeGreaterThan(-1);
    expect(firstPostIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeLessThan(firstPostIdx);
  });

  it("index.ts mounts the router (not bare handlers) under /api/internal/local-runs", () => {
    expect(routesIndexSrc).toMatch(
      /app\.use\(\s*["'`]\/api\/internal\/local-runs["'`]\s*,\s*localRunsRouter\(\)\s*\)/,
    );
  });

  it("the auth middleware fail-closes to a generic 401 on every branch", () => {
    const codes = authSrc.match(/code:\s*["'`]([a-z_]+)["'`]/g) ?? [];
    expect(codes.every((c) => /unauthorized|mac_worker_token_anomaly/.test(c))).toBe(true);
  });
});

describe("no handler trusts client-supplied owner / tenant for scoping", () => {
  it("no handler reads req.body.owner", () => {
    expect(handlersSrc).not.toMatch(/req\.body[.\[]\s*["'`]?owner/);
  });

  it("owner always comes from getMacWorker(req) (the gated, derived caller)", () => {
    const ownerUses = handlersSrc.match(/owner/g)?.length ?? 0;
    expect(ownerUses).toBeGreaterThan(0);
    expect(handlersSrc).toMatch(/getMacWorker\(req\)/);
  });

  it("tenant for /start /renew /secrets /terminal is re-derived from a DB row, never req.body", () => {
    expect(handlersSrc).toMatch(/assertTokenTenantEnabled\(\s*token_id\s*,\s*tenant_id\s*\)/);
    expect(handlersSrc).toMatch(/const tenant = run\.tenant_id/);
    expect(handlersSrc).toMatch(/const tenant_id = item\.tenant_id/);
  });
});

describe("token tables are RLS-locked + /secrets accepts no key param", () => {
  it("both token tables enable RLS", () => {
    expect(migrationSrc).toMatch(/alter table mac_worker_tokens enable row level security/);
    expect(migrationSrc).toMatch(/alter table mac_worker_token_tenants enable row level security/);
  });

  it("no CREATE POLICY exists on the token tables (deny-all to anon/authenticated)", () => {
    expect(migrationSrc).not.toMatch(/create policy/i);
  });

  it("all four RPCs are service_role-only (no grant to authenticated/anon)", () => {
    const grantLines = migrationSrc
      .split("\n")
      .filter((l) => /^grant execute on function/.test(l.trim()));
    expect(grantLines.length).toBe(4);
    for (const l of grantLines) {
      expect(l).toMatch(/to service_role\s*;?\s*$/);
      expect(l).not.toMatch(/\b(anon|authenticated)\b/);
    }
    for (const fn of [
      "mint_mac_worker_token",
      "revoke_mac_worker_token",
      "mac_worker_can_access",
      "claim_local_run_terminal",
    ]) {
      expect(grantLines.some((l) => l.includes(`function ${fn}`))).toBe(true);
    }
  });

  it("/secrets derives creds from work_item payload + vault, never from a request key param", () => {
    const secretsStart = handlersSrc.indexOf("export async function localRunsSecrets");
    const secretsEnd = handlersSrc.indexOf("export async function localRunsTerminal");
    const secretsBody = handlersSrc.slice(secretsStart, secretsEnd);
    expect(secretsBody).not.toMatch(/req\.body/);
    expect(secretsBody).toMatch(/payload as \{ repo_hint\?/);
  });

  it("/secrets does NOT read payload/agent_slug before the authz gate (read-after-authz, codex P1)", () => {
    const secretsStart = handlersSrc.indexOf("export async function localRunsSecrets");
    const secretsEnd = handlersSrc.indexOf("export async function localRunsTerminal");
    const secretsBody = handlersSrc.slice(secretsStart, secretsEnd);
    const gateIdx = secretsBody.indexOf("assertTokenTenantEnabled");
    expect(gateIdx).toBeGreaterThan(-1);
    const beforeGate = secretsBody.slice(0, gateIdx);
    const firstSelect = beforeGate.match(/\.select\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    expect(firstSelect?.[1]).toBe("id, tenant_id, lane, status, lease_owner");
    const afterLease = secretsBody.slice(secretsBody.indexOf("not_lease_holder"));
    expect(afterLease).toMatch(/\.select\(\s*["'`]payload, agent_slug["'`]\s*\)/);
  });

  it("mac_worker_can_access re-checks revoked_at (revocation completeness, grok)", () => {
    const fnStart = migrationSrc.indexOf("create function mac_worker_can_access");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = migrationSrc.slice(fnStart, migrationSrc.indexOf("$$;", fnStart));
    expect(fnBody).toMatch(
      /from mac_worker_tokens t\s+where t\.id = p_token_id and t\.revoked_at is null/,
    );
  });
});
