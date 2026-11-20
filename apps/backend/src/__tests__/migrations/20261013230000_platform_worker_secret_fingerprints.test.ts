import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20261013230000_platform_worker_secret_fingerprints.sql"),
  "utf8",
).toLowerCase();

describe("20261013230000 platform_worker_secret_fingerprints", () => {
  it("is service-role only: RLS on, no policies, revoked from client roles", () => {
    expect(SQL).toContain("alter table platform_worker_secret_fingerprints enable row level security");
    expect(SQL).not.toMatch(/create policy/);
    expect(SQL).toContain("revoke all on public.platform_worker_secret_fingerprints from public, anon, authenticated");
    expect(SQL).not.toMatch(/grant\s+(select|insert|update|delete|all)/);
  });

  it("stores a 64-hex fingerprint, never a value column, keyed per account + worker + secret", () => {
    expect(SQL).toContain("fingerprint ~ '^[0-9a-f]{64}$'");
    expect(SQL).not.toMatch(/\bvalue\b\s+text/);
    expect(SQL).toContain("primary key (account_id, worker_name, secret_name)");
  });

  it("is additive only", () => {
    expect(SQL).not.toMatch(/\bdrop\s+(table|column)\b/);
    expect(SQL).toContain("create table if not exists");
  });
});
