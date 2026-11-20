
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260917120000_extension_screenshots.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260917120000_extension_screenshots.sql", () => {
  it("creates the ledger with the ownership + soft-delete columns", () => {
    expect(code).toMatch(/create table if not exists public\.extension_screenshots/i);
    expect(code).toMatch(/tenant_id uuid not null references tenants\(id\) on delete cascade/i);
    expect(code).toMatch(/user_id uuid not null/i);
    expect(code).toMatch(/image_path text not null unique/i);
    expect(code).toMatch(/created_at timestamptz not null default now\(\)/i);
    expect(code).toMatch(/deleted_at timestamptz/i);
  });

  it("enables RLS and gives no client role any privilege", () => {
    expect(code).toMatch(/alter table public\.extension_screenshots enable row level security/i);
    expect(code).toMatch(/revoke all on public\.extension_screenshots from anon, authenticated/i);
    expect(code).not.toMatch(/grant\s+\w+.*on\s+(public\.)?extension_screenshots\s+to\s+(anon|authenticated)/i);
    expect(code).not.toMatch(/create policy/i);
  });
});
