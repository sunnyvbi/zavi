import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260528082249_dream_candidates.sql",
  ),
  "utf-8",
);

describe("20260528082249_dream_candidates.sql", () => {
  it("creates the dream_candidates table", () => {
    expect(sql).toMatch(/create table dream_candidates/i);
  });

  it("constrains verdict to the actionable set (NO_CONFLICT is never staged)", () => {
    expect(sql).toMatch(
      /verdict text not null check \(verdict in \('KEEP_NEW', 'KEEP_OLD', 'MERGE'\)\)/i,
    );
  });

  it("defaults label to pending with a 3-state check", () => {
    expect(sql).toMatch(
      /label text not null default 'pending' check \(label in \('pending', 'approved', 'rejected'\)\)/i,
    );
  });

  it("keeps merged_body + provenance columns for the deferred MERGE writeNote", () => {
    expect(sql).toMatch(/merged_body text/i);
    expect(sql).toMatch(/note_type text/i);
    expect(sql).toMatch(/source_ref text/i);
  });

  it("enforces ONE pending candidate per (tenant,new,existing) via a partial unique index", () => {
    expect(sql).toMatch(
      /create unique index dream_candidates_pending_uq[\s\S]*on dream_candidates \(tenant_id, new_note_id, existing_note_id\)[\s\S]*where label = 'pending'/i,
    );
  });

  it("enables RLS and grants members SELECT-only on their own tenant (the founder gate — no write policy)", () => {
    expect(sql).toMatch(/alter table dream_candidates enable row level security/i);
    expect(sql).toMatch(/create policy dream_candidates_member_select on dream_candidates\s+for select/i);
    expect(sql).not.toMatch(/create policy[^\n]*for (insert|update|delete)/i);
  });
});
