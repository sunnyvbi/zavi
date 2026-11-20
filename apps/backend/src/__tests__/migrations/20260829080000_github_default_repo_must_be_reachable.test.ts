import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260829080000_github_default_repo_must_be_reachable.sql",
);

describe("migration 20260829080000_github_default_repo_must_be_reachable", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("backfills orphaned defaults BEFORE the trigger exists (audit once, not twice)", () => {
    const backfillAt = sql.indexOf("with orphaned as");
    const triggerAt = sql.indexOf("create trigger connector_metadata_github_default_reachable");
    expect(backfillAt).toBeGreaterThan(-1);
    expect(triggerAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeLessThan(triggerAt);
  });

  it("backfill treats a NULL reachability test as unreachable, not as a skip", () => {
    expect(sql).toMatch(/coalesce\([\s\S]{0,200}?= any\(cm\.selected_repo_ids\),\s*false\s*\) = false/);
  });

  it("backfill only touches github rows that are actually scoped", () => {
    expect(sql).toMatch(/where cm\.slug = 'github'/);
    expect(sql).toMatch(/and cm\.default_repo_full_name is not null/);
    expect(sql).toMatch(/and cm\.selected_repo_ids is not null/);
  });

  it("backfill writes a system-actor audit row naming the reason", () => {
    expect(sql).toMatch(/insert into tenant_config_audit/);
    expect(sql).toMatch(/'00000000-0000-0000-0000-000000000000'::uuid/);
    expect(sql).toMatch(/'migration_20260829080000'/);
    expect(sql).toMatch(/default_repo_not_in_selected_repos/);
  });

  it("defines the trigger function as SECURITY DEFINER so the audit insert survives RLS", () => {
    expect(sql).toMatch(
      /create or replace function connector_metadata_github_default_reachable_tg\(\)[\s\S]*?security definer/i,
    );
    expect(sql).toMatch(/set search_path = public, pg_temp/);
    expect(sql).toMatch(
      /revoke all on function connector_metadata_github_default_reachable_tg\(\) from public/,
    );
  });

  it("trigger no-ops on non-github rows and on the unscoped (NULL selection) case", () => {
    expect(sql).toMatch(/if new\.slug is distinct from 'github' then\s*return new;/);
    expect(sql).toMatch(
      /if new\.default_repo_full_name is null or new\.selected_repo_ids is null then\s*return new;/,
    );
  });

  it("trigger tests membership in ID space, not by full_name", () => {
    expect(sql).toMatch(/array_position\(coalesce\(new\.repo_full_names/);
    expect(sql).toMatch(/v_id := new\.repo_ids\[v_pos\];/);
    expect(sql).toMatch(/if v_id = any\(new\.selected_repo_ids\) then\s*return new;/);
  });

  it("trigger clears the default rather than raising (never bricks an unrelated write)", () => {
    const start = sql.indexOf(
      "create or replace function connector_metadata_github_default_reachable_tg()",
    );
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf("end $$;", start));
    expect(body).toMatch(/new\.default_repo_full_name := null;/);
    expect(body).not.toMatch(/raise exception/);
  });

  it("fires BEFORE INSERT OR UPDATE for each row, and is idempotently re-creatable", () => {
    expect(sql).toMatch(
      /drop trigger if exists connector_metadata_github_default_reachable\s*\n?\s*on connector_metadata/,
    );
    expect(sql).toMatch(/before insert or update on connector_metadata/);
    expect(sql).toMatch(/for each row/);
  });

  it("set_github_default_repo refuses a pick the selection excludes, with its own message", () => {
    expect(sql).toMatch(/create or replace function set_github_default_repo/i);
    expect(sql).toMatch(/is not in the tenant''s selected repositories/);
    expect(sql).toMatch(/using errcode = '23514'/);
  });

  it("set_github_default_repo keeps its admin gate, atomic guard, and audit", () => {
    expect(sql).toMatch(/perform _assert_tenant_admin\(p_tenant_id\)/);
    expect(sql).toMatch(/p_repo_full_name = any\(repo_full_names\)/);
    expect(sql).toMatch(/get diagnostics v_updated = row_count/i);
    expect(sql).toMatch(
      /grant execute on function set_github_default_repo[\s\S]*?to authenticated/i,
    );
  });

  it("leaves the unscoped case alone in the RPC too (NULL selection = every repo legal)", () => {
    expect(sql).toMatch(/if v_selected is not null then/);
  });

  it("never WIDENS reachability — no grant/insert that adds a repo to a selection", () => {
    expect(sql).not.toMatch(/set selected_repo_ids/i);
  });
});
