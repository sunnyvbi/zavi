import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runAgent = readFileSync(
  join(__dirname, "../../../workers/functions/run-agent.ts"),
  "utf-8",
);
const e2bClient = readFileSync(
  join(__dirname, "../../services/sandbox/e2b-client.ts"),
  "utf-8",
);
const settingsRoute = readFileSync(
  join(__dirname, "../../routes/tenant/settings.ts"),
  "utf-8",
);
const migration = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0063_tenant_sandbox_keepalive.sql"),
  "utf-8",
);

describe("run-agent.ts — finally block wiring", () => {
  it("imports getTenantSandboxKeepalive, revokeSandboxGithubToken, pauseAndMarkPaused, extendSandboxTimeout", () => {
    expect(runAgent).toMatch(/import \{[\s\S]*getTenantSandboxKeepalive[\s\S]*\}/);
    expect(runAgent).toMatch(/import \{[\s\S]*revokeSandboxGithubToken[\s\S]*\}/);
    expect(runAgent).toMatch(/import \{[\s\S]*pauseAndMarkPaused[\s\S]*\}/);
    expect(runAgent).toMatch(/import \{[\s\S]*extendSandboxTimeout[\s\S]*\}/);
  });

  it("revokes the token (which wipes the secrets) before the keepalive branch", () => {
    const finallyBlock = runAgent.match(/\} finally \{[\s\S]*?\n {4}\}/);
    expect(finallyBlock).not.toBeNull();
    const block = finallyBlock?.[0] ?? "";
    const wipeIdx = block.indexOf("revokeSandboxGithubToken(sandbox.e2b_sandbox_id)");
    const flagIdx = block.indexOf("getTenantSandboxKeepalive(claim.tenant_id)");
    expect(wipeIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(wipeIdx);
  });

  it("threads claim.tenant_id into the keepalive read", () => {
    expect(runAgent).toMatch(/getTenantSandboxKeepalive\(claim\.tenant_id\)/);
  });

  it("does NOT call the old pauseSandboxAfterRun from run-agent finally", () => {
    expect(runAgent).not.toMatch(/pauseSandboxAfterRun\(sandbox\)/);
  });
});

describe("e2b-client.ts — autoPause config", () => {
  it("calls Sandbox.betaCreate (not Sandbox.create) with autoPause: true", () => {
    expect(e2bClient).toMatch(/Sandbox\.betaCreate\(/);
    expect(e2bClient).toMatch(/autoPause:\s*true/);
  });

  it("does NOT use the unsupported lifecycle.onTimeout shape", () => {
    expect(e2bClient).not.toMatch(/lifecycle:\s*\{\s*onTimeout/);
  });

  it("exports extendSandboxTimeout", () => {
    expect(e2bClient).toMatch(/export async function extendSandboxTimeout\(/);
  });
});

describe("routes/tenant/settings.ts — PATCH route security", () => {
  it("uses serverClientFromBearer + RPC, NOT serviceClient or direct .update()", () => {
    expect(settingsRoute).toMatch(/serverClientFromBearer/);
    expect(settingsRoute).toMatch(
      /supabase\.rpc\("set_tenant_sandbox_keepalive"/,
    );
    expect(settingsRoute).not.toMatch(/\bserviceClient\b/);
    expect(settingsRoute).not.toMatch(/\.update\(/);
  });

  it("validates body with z.strict() + at-least-one-key refine", () => {
    expect(settingsRoute).toMatch(/\.strict\(\)/);
    expect(settingsRoute).toMatch(/at least one setting required/);
  });

  it("invalidates the tenant-keepalive cache after a successful write", () => {
    expect(settingsRoute).toMatch(/invalidateTenantKeepaliveCache\(auth\.tenant_id\)/);
  });
});

describe("migration 0063 — security-definer RPC", () => {
  it("creates the column with default true", () => {
    expect(migration).toMatch(
      /add column if not exists sandbox_keepalive_enabled boolean not null default true/,
    );
  });

  it("creates a security-definer RPC scoped to tenant_users membership", () => {
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/set_tenant_sandbox_keepalive\(\s*p_tenant_id uuid,\s*p_enabled boolean\s*\)/);
    expect(migration).toMatch(/from tenant_users\s+where user_id = auth\.uid\(\)/);
  });

  it("grants execute only to authenticated; no broad UPDATE on tenants", () => {
    expect(migration).toMatch(
      /grant execute on function set_tenant_sandbox_keepalive\(uuid, boolean\) to authenticated/,
    );
    expect(migration).not.toMatch(/create policy.*update.*on tenants/i);
  });
});
