import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SETTINGS } from "@/services/settings/registry";

describe("memory_stale_archive_enabled — default-ON gate", () => {
  it("exists, is a per-tenant boolean, and defaults to ON", () => {
    const def = (APP_SETTINGS as Record<string, { type: string; scope: string; defaultValue: unknown }>)[
      "memory_stale_archive_enabled"
    ];
    expect(def).toBeDefined();
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(true);
  });
});

describe("stale-archive migration — recall RPCs exclude archived notes", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../supabase/migrations/20260630000120_memory_note_stale_archive_ttl.sql"),
    "utf8",
  );

  it("adds the archived_at column", () => {
    expect(sql).toMatch(/alter table memory_note add column if not exists archived_at timestamptz/i);
  });

  it("filters archived_at in lockstep with superseded_by in EVERY recall candidate CTE", () => {
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const superseded = code.match(/n\.superseded_by is null/g) ?? [];
    const archived = code.match(/n\.archived_at is null/g) ?? [];
    expect(superseded.length).toBe(5);
    expect(archived.length).toBe(5);
    const colocated = code.match(/n\.superseded_by is null\s*\n\s*and n\.archived_at is null/gi) ?? [];
    expect(colocated.length).toBe(5);
  });

  it("rebuilds all three recall RPCs", () => {
    expect(sql).toMatch(/create or replace function memory_search_hybrid\(/);
    expect(sql).toMatch(/create or replace function memory_search_hybrid_v2\(/);
    expect(sql).toMatch(/create or replace function memory_search_lex_or\(/);
  });
});
