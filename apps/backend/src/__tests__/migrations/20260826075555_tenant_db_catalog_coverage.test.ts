import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname, "..", "..", "..", "..", "..", "supabase", "migrations",
  "20260826075555_tenant_db_catalog_coverage.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf-8");

describe("coverage column", () => {
  it("is additive and defaulted, so existing rows stay valid", () => {
    expect(sql).toMatch(/alter table tenant_db_catalog\s+add column if not exists coverage jsonb not null default '\{\}'::jsonb/i);
  });
});

describe("catalog_hash must NOT change — the confirmed-mapping invariant", () => {
  it("hashes exactly dialect + catalog + hints, never coverage", () => {
    const hashLines = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .filter((l) => l.includes("md5("));
    expect(hashLines.length).toBeGreaterThan(0);
    for (const line of hashLines) {
      expect(line).toMatch(/md5\(p_dialect \|\| v_catalog::text \|\| v_hints::text\)/);
      expect(line).not.toMatch(/v_cov|p_coverage/);
    }
  });

  it("never writes coverage into the catalog or hints columns", () => {
    expect(sql).not.toMatch(/catalog\s*=\s*[^,\n]*cov/i);
    expect(sql).not.toMatch(/hints\s*=\s*[^,\n]*cov/i);
  });
});

describe("the 6-arg overload", () => {
  it("takes NO default for p_coverage — a default makes the 5-arg call ambiguous", () => {
    expect(sql).toMatch(/p_coverage jsonb\s*\n?\s*\)/);
    expect(sql).not.toMatch(/p_coverage jsonb\s+default/i);
  });

  it("persists coverage on BOTH insert and conflict-update", () => {
    expect(sql).toMatch(/insert into tenant_db_catalog \([\s\S]*?coverage[\s\S]*?\)/i);
    expect(sql).toMatch(/do update set[\s\S]*?coverage = excluded\.coverage/i);
  });
});

describe("the legacy 5-arg form", () => {
  it("is kept, so the migrate step can run before the container swap", () => {
    expect(sql).toMatch(/create or replace function set_tenant_db_catalog\(\s*p_tenant_id uuid,\s*p_dialect text,\s*p_catalog jsonb,\s*p_hints jsonb,\s*p_discovery_error text\s*\)/i);
  });

  it("RESETS coverage to '{}' so a stale record can't outlive its catalog", () => {
    expect(sql).toMatch(/perform set_tenant_db_catalog\([\s\S]*?'\{\}'::jsonb\s*\)/i);
  });
});

describe("access model", () => {
  it("revokes both forms from public, anon AND authenticated", () => {
    for (const sig of [
      "set_tenant_db_catalog\\(uuid, text, jsonb, jsonb, text, jsonb\\)",
      "set_tenant_db_catalog\\(uuid, text, jsonb, jsonb, text\\)",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${sig}\\s*\\n?\\s*from public, anon, authenticated`, "i"));
    }
  });

  it("grants execute to service_role only — never to authenticated", () => {
    expect(sql).toMatch(/grant execute on function set_tenant_db_catalog\(uuid, text, jsonb, jsonb, text, jsonb\)\s*\n?\s*to service_role/i);
    expect(sql).not.toMatch(/grant execute on function set_tenant_db_catalog[\s\S]*?to authenticated/i);
  });

  it("keeps both forms security definer with a pinned search_path", () => {
    const defs = sql.match(/language plpgsql security definer set search_path = public, pg_temp/gi) ?? [];
    expect(defs.length).toBe(2);
  });
});
