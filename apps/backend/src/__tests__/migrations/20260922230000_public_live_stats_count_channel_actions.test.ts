import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^\d{14}_public_live_stats_count_channel_actions\.sql$/.test(f));
if (!file) throw new Error("public_live_stats_count_channel_actions migration not found");

const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

describe("public_live_stats channel-actions follow-up migration", () => {
  it("filters to kind = 'real' tenants in every branch", () => {
    const joins = sql.match(/join public\.tenants t on t\.id = \w+\.tenant_id/g) ?? [];
    const kinds = sql.match(/t\.kind = 'real'/g) ?? [];
    expect(joins.length).toBe(6);
    expect(kinds.length).toBe(6);
  });

  it("sums agent_runs.cost_tokens over successful runs", () => {
    expect(sql).toMatch(/sum\(coalesce\(ar\.cost_tokens, 0\)\)/);
    expect((sql.match(/ar\.status = 'success'/g) ?? []).length).toBe(2);
  });

  it("counts only human-approved, carried-out decisions", () => {
    expect((sql.match(/d\.status = 'acted'/g) ?? []).length).toBe(2);
    expect((sql.match(/d\.approved_at is not null/g) ?? []).length).toBe(2);
    expect((sql.match(/d\.handler is not null/g) ?? []).length).toBe(2);
    expect((sql.match(/ca\.exec_status = 'executed'/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/ca\.executed_at >= now\(\) - interval '7 days'/);
  });

  it("revokes execute from anon and authenticated, grants service_role only", () => {
    expect(sql).toMatch(
      /revoke all on function public\.public_live_stats\(\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(/grant execute on function public\.public_live_stats\(\) to service_role;/);
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
  });

  it("is SECURITY INVOKER, not SECURITY DEFINER, with a fixed search_path", () => {
    expect(sql).not.toMatch(/security definer/);
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/set search_path = public, pg_temp/);
  });
});
