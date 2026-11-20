
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");

const FIX = read("20260905001727_fix_human_member_handles_column.sql");
const RENAME = read("20260904121802_rename_bench_to_humans.sql");
const ORIGIN = read("20260901010000_bench_identity_and_engagement_plane.sql");

describe("20260905001727 — human_member_handles column repair", () => {
  it("renames the column the search function actually reads", () => {
    expect(FIX).toMatch(
      /alter table human_member_handles rename column bench_member_id to human_member_id/i,
    );
  });

  it("is guarded on the column still existing, so a re-run is a no-op", () => {
    expect(FIX).toMatch(/information_schema\.columns/i);
    expect(FIX).toMatch(/table_name\s*=\s*'human_member_handles'/i);
    expect(FIX).toMatch(/column_name\s*=\s*'bench_member_id'/i);
  });

  it("documents the defect it repairs rather than only the DDL", () => {
    expect(FIX).toMatch(/42703/);
  });

  it("pins the three sources of the defect", () => {
    expect(ORIGIN).toMatch(/create table if not exists bench_member_handles \(/i);
    expect(ORIGIN).toMatch(/bench_member_id\s+uuid not null references bench_members\(id\)/i);
    expect(RENAME).toMatch(
      /alter table if exists bench_member_handles rename to human_member_handles/i,
    );
    expect(RENAME).toMatch(
      /alter table brief_applications rename column bench_member_id to human_member_id/i,
    );
    expect(RENAME).toMatch(
      /alter table engagements rename column bench_member_id to human_member_id/i,
    );
    expect(RENAME).not.toMatch(
      /alter table human_member_handles rename column bench_member_id/i,
    );
    expect(RENAME).toMatch(/from human_member_handles h\s*\n\s*where h\.human_member_id = m\.id/i);
  });
});
