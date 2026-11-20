import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260927120000_creator_product_needed.sql"),
  "utf8",
);
const code = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("20260927120000_creator_product_needed", () => {
  it("adds the four columns the order path reads", () => {
    expect(code).toMatch(/alter table public\.creator_orders[\s\S]*add column if not exists product_needed boolean not null default false/);
    expect(code).toMatch(/add column if not exists product_received_at timestamptz/);
    expect(code).toMatch(/alter table public\.creator_briefs\s+add column if not exists product_needed boolean not null default false/);
    expect(code).toMatch(/alter table public\.creator_offers\s+add column if not exists product_needed boolean not null default false/);
  });

  it("is additive only: no drop, no replace, no grant, no data rewrite", () => {
    for (const banned of ["drop ", "create or replace", "grant ", "revoke ", "update ", "delete ", "alter column", "rename "]) {
      expect(code, banned).not.toContain(banned);
    }
  });
});
