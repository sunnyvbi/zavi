import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261009100100_cgo_note_items.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261009100100_cgo_note_items", () => {
  it("adds items and headline as nullable columns", () => {
    expect(code).toContain("alter table cgo_notes add column if not exists items jsonb, add column if not exists headline text;");
  });
  it("items is null or a non-empty array; headline at most 200 chars", () => {
    expect(code).toContain("check (items is null or (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0))");
    expect(code).toContain("check (headline is null or char_length(headline) <= 200)");
  });
  it("indexes the blocked-since-last-note read and the last shown note", () => {
    expect(code).toContain(
      "create index if not exists channel_actions_blocked_recent_idx on channel_actions (tenant_id, status_at desc) where status = 'stale' and exec_status = 'failed';",
    );
    expect(code).toContain(
      "create index if not exists cgo_notes_tenant_shown_idx on cgo_notes (tenant_id, created_at desc) where items is not null or changed <> '{}' or need <> '{}' or would_change <> '{}';",
    );
  });
  it("is additive: no dropped column, no type change, no delete, no rewrite of notes", () => {
    expect(code).not.toMatch(/drop column/i);
    expect(code).not.toMatch(/alter column \S+ type/i);
    expect(code).not.toMatch(/delete from/i);
    expect(code).not.toMatch(/update cgo_notes/i);
  });
  it("runs in one transaction", () => {
    expect(code.trim().startsWith("begin;")).toBe(true);
    expect(code.trim().endsWith("commit;")).toBe(true);
  });
});
