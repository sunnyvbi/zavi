import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261011100000_conductor_runs_build_app_per_site_indexes.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\s+/g, " ");

describe("conductor_runs per-app build indexes (20261011100000)", () => {
  it("indexes a tenant's builds newest first, build_app rows only", () => {
    expect(code).toContain(
      "create index if not exists conductor_runs_build_app_tenant_created_idx on conductor_runs (tenant_id, created_at desc) where kind = 'build_app';",
    );
  });

  it("indexes one app's builds on the exact expression PostgREST emits for goal_graph->0->payload->>site_id", () => {
    expect(code).toContain(
      "create index if not exists conductor_runs_build_app_site_idx on conductor_runs (tenant_id, ((goal_graph->0->'payload'->>'site_id')), created_at desc) where kind = 'build_app';",
    );
  });

  it("only adds indexes (no table rewrite, no data change)", () => {
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.every((s) => s.startsWith("create index if not exists"))).toBe(true);
  });
});
