import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    process.cwd(),
    "../../supabase/migrations/20260714110500_engineer_preview_path_and_outcome.sql",
  ),
  "utf8",
);

describe("engineer preview path+outcome migration", () => {
  it("adds all three columns additively (never NOT NULL — every existing row must survive)", () => {
    expect(SQL).toMatch(/add column if not exists preview_path text/i);
    expect(SQL).toMatch(/add column if not exists preview_outcome text/i);
    expect(SQL).toMatch(/add column if not exists preview_off_target_reason text/i);

    const alter = SQL.match(/alter table public\.tenant_sandbox[\s\S]*?;/i)?.[0] ?? "";
    expect(alter).toContain("preview_path");
    expect(alter).not.toMatch(/not null/i);
  });

  it("CHECK-constrains preview_outcome to the two-value enum (+ null)", () => {
    expect(SQL).toMatch(/tenant_sandbox_preview_outcome_chk/);
    expect(SQL).toMatch(/preview_outcome is null or preview_outcome in \('on_target','off_target'\)/i);
  });

  it("CHECK-constrains the reason to the whitelist, and does NOT include a no_route token", () => {
    expect(SQL).toMatch(/tenant_sandbox_preview_off_target_reason_chk/);
    expect(SQL).toMatch(/'auth_or_redirect','route_error','no_marker'/);
    expect(SQL).not.toMatch(/'no_route'/);
  });

  it("DROPs the 5-arg overload before creating the 8-arg one (PostgREST ambiguity trap)", () => {
    const drop = SQL.indexOf("drop function if exists set_engineer_sandbox_preview(uuid, text, int, text, text)");
    const create = SQL.search(/create or replace function\s+set_engineer_sandbox_preview/i);
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(create);
  });

  it("RESETS path/outcome/reason on 'starting' — the stale-row bug", () => {
    expect(SQL).toMatch(/preview_path\s*=\s*case\s+when p_status = 'starting' then left\(p_path, 500\)/i);
    expect(SQL).toMatch(/preview_outcome\s*=\s*case\s+when p_status = 'starting' then null/i);
    expect(SQL).toMatch(
      /preview_off_target_reason\s*=\s*case\s+when p_status = 'starting' then null/i,
    );
  });

  it("is a clean SUPERSET of the prior definition — still writes every column it used to", () => {
    for (const col of [
      "preview_url",
      "preview_port",
      "preview_status",
      "preview_run_id",
      "preview_error",
      "preview_started_at",
      "preview_last_viewed_at",
      "updated_at",
    ]) {
      expect(SQL).toContain(col);
    }
  });

  it("keeps writes on the security-definer path, granted only to service_role", () => {
    expect(SQL).toMatch(/language plpgsql security definer set search_path = public, pg_temp/i);
    expect(SQL).toMatch(/grant execute on function set_engineer_sandbox_preview\([^)]*\) to service_role/i);
    expect(SQL).toMatch(/revoke all on function set_engineer_sandbox_preview\([^)]*\) from public/i);
  });
});
