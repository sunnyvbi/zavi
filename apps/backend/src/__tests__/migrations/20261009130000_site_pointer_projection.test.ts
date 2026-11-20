import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261009130000_site_pointer_projection.sql"), "utf-8");
const PRIOR = readFileSync(join(dir, "20261008090000_sites.sql"), "utf-8");

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("end $$;", start));
}

const DESIRED = "(case when s.status in ('deleting', 'deleted', 'fell_back_old') then null else s.live_deploy_id end)";

describe("20261009130000_site_pointer_projection.sql", () => {
  it.each([
    ["site_activate_if_desired", "uuid, uuid, text, text, text"],
    ["site_mark_projected", "uuid, uuid, text, boolean"],
    ["site_note_projection_drift", "uuid, uuid"],
    ["site_projection_drift_batch", "timestamptz, int"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(sql, name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("is one transaction with additive columns", () => {
    expect(sql.trimStart().split("\n").find((l) => l.trim() && !l.startsWith("--"))).toBe("begin;");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("add column if not exists kv_deploy_id    text");
    expect(sql).toContain("add column if not exists kv_drift_count  int not null default 0");
    expect(sql).not.toMatch(/drop (table|column)/i);
  });

  it("site_activate_if_desired is a clean superset of its prior definition plus the monotonic guard (DB-fn-rebuild gate)", () => {
    const prior = fnBody(PRIOR, "site_activate_if_desired");
    const next = fnBody(sql, "site_activate_if_desired");
    const dropped = prior
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith("--"))
      .filter((l) => !next.includes(l));
    expect(dropped).toEqual(["and s.status not in ('deleting', 'deleted', 'fell_back_old');"]);
    expect(next).toContain("and s.status not in ('deleting', 'deleted', 'fell_back_old')");
    expect(next).toContain("s.desired_sha = p_sha");
    expect(next).toContain(`(substr(s.live_deploy_id, 2, 9) collate "C") <= (substr(p_deploy_id, 2, 9) collate "C")`);
    expect(next).toContain("s.live_deploy_id is null");
    expect(next).toContain("s.live_deploy_id !~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'");
  });

  it("site_mark_projected is a compare-and-set on the desired projection, tenant-scoped, and never touches updated_at", () => {
    const body = fnBody(sql, "site_mark_projected");
    expect(body).toContain("where s.id = p_site_id and s.tenant_id = p_tenant_id");
    expect(body).toContain(`${DESIRED}\n        is not distinct from p_deploy_id`);
    expect(body).toMatch(/if not found then\s+return -1;/);
    expect(body).toContain("case when coalesce(p_drift, false) then s.kv_drift_count + 1 else 0 end");
    expect(body).not.toMatch(/updated_at/);
    expect(body).not.toMatch(/live_deploy_id\s*=/);
  });

  it("a site entering a terminal status is marked drifted until its host record is confirmed gone", () => {
    const body = fnBody(sql, "sites_terminal_dirties_projection");
    expect(body).toMatch(/new\.status in \('deleting', 'deleted', 'fell_back_old'\)\s+and old\.status not in \('deleting', 'deleted', 'fell_back_old'\)/);
    expect(body).toContain("new.kv_deploy_id := 'pending-removal';");
    expect(sql).toMatch(/create trigger sites_terminal_dirties_projection\s+before update of status on public\.sites\s+for each row execute function public\.sites_terminal_dirties_projection\(\);/);
  });

  it("site_note_projection_drift only bumps the counter of p_tenant_id's site", () => {
    const body = fnBody(sql, "site_note_projection_drift");
    expect(body).toContain("where s.id = p_site_id and s.tenant_id = p_tenant_id");
    expect(body).not.toMatch(/updated_at|live_deploy_id|kv_deploy_id\s*=/);
  });

  it("site_projection_drift_batch is read-only, returns only (tenant_id, site_id), and matches the partial index predicate", () => {
    const body = fnBody(sql, "site_projection_drift_batch");
    expect(body).toMatch(/returns table \(tenant_id uuid, site_id uuid\)/i);
    expect(body).not.toMatch(/\b(update|delete|insert)\b/i);
    expect(body).toContain(`s.kv_deploy_id is distinct from\n           ${DESIRED}`);
    expect(body).toContain("s.updated_at < p_settle_before");
    expect(body).toContain("limit least(greatest(coalesce(p_limit, 100), 1), 500)");
    expect(sql).toMatch(
      /create index if not exists sites_kv_drift_idx on public\.sites \(updated_at\)\s+where kv_deploy_id is distinct from\s+\(case when status in \('deleting', 'deleted', 'fell_back_old'\) then null else live_deploy_id end\);/,
    );
  });
});
