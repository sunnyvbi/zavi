import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^\d{14}_start_card_reports\.sql$/.test(f));
if (!file) throw new Error("start_card_reports migration not found");

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

describe("start_card_reports migration", () => {
  it("enables AND forces RLS, creates no policy, and revokes browser privileges", () => {
    expect(sql).toContain("alter table public.start_card_reports enable row level security;");
    expect(sql).toContain("alter table public.start_card_reports force row level security;");
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toContain("revoke all on table public.start_card_reports from public, anon, authenticated;");
    expect(sql).not.toMatch(/grant [^;]* on table [^;]* to (anon|authenticated|public)/);
  });

  it("a removal row can never hold an email, and a report row always has one", () => {
    expect(sql).toMatch(/kind = 'removal' and verify_token_hash is not null and email is null/);
    expect(sql).toMatch(/kind = 'report' and verify_token_hash is null and email is not null/);
  });
});
