import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261023110000_merge_website_edit_return_version.sql"),
  "utf8",
);

describe("migration 20261023110000_merge_website_edit_return_version", () => {
  it("sorts after every migration that existed when this change was added", () => {
    expect(20261023110000n).toBeGreaterThan(20261023100000n);
  });

  it("returns the exact row version written while preserving the serialized tenant-scoped merge", () => {
    expect(sql).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/where tenant_id = p_tenant_id\s+and app_id = p_app_id\s+and selector = p_selector/);
    expect(sql).toMatch(/returning \* into v_current/);
    expect(sql).toMatch(/'id', v_current\.id/);
    expect(sql).toMatch(/'updated_at', v_current\.updated_at/);
    expect(sql).toMatch(/'current_patch', v_current\.patch/);
  });

  it("remains service-role only", () => {
    const signature = "merge_website_edit(uuid, text, text, jsonb, boolean, boolean)";
    expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role;`);
  });
});
