import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0054_unsupersede_memory_note_revoke_authenticated.sql",
  ),
  "utf-8",
);

describe("0054_unsupersede_memory_note_revoke_authenticated.sql", () => {
  it("revokes execute from authenticated", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+unsupersede_memory_note\s*\([^)]+\)\s+from\s+authenticated/i,
    );
  });

  it("revokes execute from public", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+unsupersede_memory_note\s*\([^)]+\)\s+from\s+public/i,
    );
  });

  it("does NOT re-grant execute to authenticated or public", () => {
    expect(sql).not.toMatch(
      /grant\s+execute\s+on\s+function\s+unsupersede_memory_note[\s\S]*?(authenticated|public)/i,
    );
  });

  it("documents why an in-function auth.uid() check is not viable here", () => {
    expect(sql).toMatch(/auth\.uid\(\)/);
    expect(sql).toMatch(/null/i);
  });
});
