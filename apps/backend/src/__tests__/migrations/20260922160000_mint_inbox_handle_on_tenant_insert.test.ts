import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");
const MIG_PATH = join(
  MIGRATIONS_DIR,
  "20260922160000_mint_inbox_handle_on_tenant_insert.sql",
);

describe("migration 20260922160000_mint_inbox_handle_on_tenant_insert", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("mints from the tenants table itself, so no creation door can skip it", () => {
    expect(sql).toMatch(
      /create trigger tenants_mint_inbox_handle\s+after insert on tenants\s+for each row\s+execute function mint_inbox_handle_on_tenant_insert\(\)/i,
    );
  });

  it("derives the handle the same way the 2026-07-13 backfill did", () => {
    expect(sql).toMatch(
      /perform mint_inbox_handle\(\s*new\.id,\s*coalesce\(nullif\(btrim\(new\.display_name\), ''\), new\.slug\)\s*\)/i,
    );
  });

  it("can never abort a tenant create, because a missing address beats a failed signup", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function mint_inbox_handle_on_tenant_insert"),
      sql.indexOf("revoke all on function mint_inbox_handle_on_tenant_insert"),
    );
    expect(fn).toMatch(/exception when others then\s+raise warning/i);
    expect(fn).not.toMatch(/raise exception/i);
  });

  it("runs as owner and is not callable by a logged-in user", () => {
    expect(sql).toMatch(
      /create or replace function mint_inbox_handle_on_tenant_insert\(\)[\s\S]*?security definer[\s\S]*?set search_path = public, pg_temp/i,
    );
    expect(sql).toMatch(
      /revoke all on function mint_inbox_handle_on_tenant_insert\(\) from authenticated, anon/i,
    );
  });

  it("backfills only the tenants that have no active identity, and survives a bad one", () => {
    const block = sql.slice(sql.lastIndexOf("do $$"));
    expect(block).toMatch(
      /not exists \(\s*select 1 from tenant_agent_email_identity i\s+where i\.tenant_id = tenants\.id and i\.status = 'active'\s*\)/i,
    );
    expect(block).toMatch(/exception when others then\s+raise warning/i);
  });

  it("never mints for a launch_video_shell, on insert or in the backfill", () => {
    expect(sql).toMatch(/if new\.kind = 'launch_video_shell' then\s+return null;\s+end if;/i);
    const block = sql.slice(sql.lastIndexOf("do $$"));
    expect(block).toMatch(/where kind <> 'launch_video_shell'/i);
  });

  it("mints when a shell is claimed, since that is when it becomes a real tenant", () => {
    expect(sql).toMatch(
      /create trigger tenants_mint_inbox_handle_on_claim\s+after update of kind on tenants\s+for each row\s+when \(old\.kind = 'launch_video_shell' and new\.kind <> 'launch_video_shell'\)/i,
    );
  });

  it("is the last word on tenant inserts — no later migration drops the trigger", () => {
    const later = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f.slice(0, 14) > "20260922160000")
      .filter((f) =>
        /drop trigger[^;]*tenants_mint_inbox_handle/i.test(
          readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
        ),
      );
    expect(later, `these migrations remove the mint trigger: ${later.join(", ")}`).toEqual([]);
  });
});
