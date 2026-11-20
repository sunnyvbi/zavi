import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

const file = readdirSync(MIGRATIONS_DIR).find((f) =>
  /^\d{14}_tenant_commands\.sql$/.test(f),
);

if (!file) {
  throw new Error(
    "tenant_commands migration not found — expected a 14-digit timestamp prefix file in supabase/migrations/",
  );
}

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

describe("tenant_commands migration", () => {
  it("creates the tenant_commands table with the expected columns", () => {
    expect(sql).toMatch(/create table tenant_commands/i);
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\)/i);
    expect(sql).toMatch(/slug\s+text not null/i);
    expect(sql).toMatch(/name\s+text not null/i);
    expect(sql).toMatch(/instructions_md\s+text not null/i);
    expect(sql).toMatch(/created_by\s+uuid references auth\.users\(id\)/i);
    expect(sql).toMatch(/unique \(tenant_id, slug\)/i);
  });

  it("caps instructions_md at 8000 chars (must fit inside the 32000 RPC limit)", () => {
    expect(sql).toMatch(/length\(instructions_md\) <= 8000/);
  });

  it("enforces the slug regex shape", () => {
    expect(sql).toMatch(/slug ~ '\^\[a-z\]\[a-z0-9-\]\{0,39\}\$'/);
  });

  it("reserves built-in command slugs", () => {
    expect(sql).toMatch(/tenant_commands_slug_not_reserved/);
    expect(sql).toMatch(
      /slug not in \('feedback','clear','help','run','decision'\)/,
    );
  });

  it("turns on RLS and ships only a member-select policy (writes go via RPCs)", () => {
    expect(sql).toMatch(/alter table tenant_commands enable row level security/i);
    expect(sql).toMatch(/create policy tenant_commands_member_select/i);
    expect(sql).not.toMatch(/create policy [^;]+ for (insert|update|delete) on tenant_commands/i);
  });

  it("all three RPCs are security-definer with explicit search_path", () => {
    for (const fn of [
      "list_tenant_commands",
      "upsert_tenant_command",
      "delete_tenant_command",
    ]) {
      const re = new RegExp(
        `create or replace function ${fn}[\\s\\S]{0,400}security definer set search_path = public`,
        "i",
      );
      expect(sql, `${fn} should be security-definer`).toMatch(re);
    }
  });

  it("list_tenant_commands enforces tenant_users membership (Phase 2 C5 — defense vs stale active_tenant)", () => {
    const fnBody = sql
      .split(/create or replace function list_tenant_commands/i)[1]
      ?.split(/create or replace function/i)[0] ?? "";
    expect(fnBody).toMatch(/select 1 from tenant_users/i);
  });

  it("delete_tenant_command enforces tenant_users membership (Phase 2 C5)", () => {
    const fnBody = sql
      .split(/create or replace function delete_tenant_command/i)[1]
      ?.split(/create or replace function/i)[0] ?? "";
    expect(fnBody).toMatch(/select 1 from tenant_users/i);
  });

  it("upsert_tenant_command enforces tenant_users membership", () => {
    const fnBody = sql
      .split(/create or replace function upsert_tenant_command/i)[1]
      ?.split(/create or replace function/i)[0] ?? "";
    expect(fnBody).toMatch(/select 1 from tenant_users/i);
  });

  it("revokes public + grants authenticated for every RPC", () => {
    for (const fn of [
      "list_tenant_commands()",
      "upsert_tenant_command(text, text, text, text)",
      "delete_tenant_command(text)",
    ]) {
      const revoke = new RegExp(
        `revoke all on function ${fn.replace(/[()]/g, "\\$&")} from public`,
        "i",
      );
      const grant = new RegExp(
        `grant execute on function ${fn.replace(/[()]/g, "\\$&")} to authenticated`,
        "i",
      );
      expect(sql).toMatch(revoke);
      expect(sql).toMatch(grant);
    }
  });
});
