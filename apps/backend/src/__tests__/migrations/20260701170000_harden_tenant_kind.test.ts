import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260701170000_harden_tenant_kind_downgrade_and_tag_capability.sql",
);

describe("migration 20260701170000_harden_tenant_kind_downgrade_and_tag_capability", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("blocks downgrading a real tenant to test (the delete-bypass step)", () => {
    expect(sql).toMatch(/create or replace function tenant_kind_downgrade_guard/i);
    expect(sql).toMatch(/old\.kind\s*=\s*'real'\s+and\s+new\.kind\s*=\s*'test'/i);
    expect(sql).toMatch(/raise exception/i);
    expect(sql).toMatch(/errcode\s*=\s*'42501'/i);
  });

  it("requires a deliberate session override to allow the downgrade", () => {
    expect(sql).toMatch(/current_setting\(\s*'app\.allow_tenant_kind_downgrade'\s*,\s*true\s*\)/i);
    expect(sql).toMatch(/<>\s*'on'/i);
  });

  it("installs a BEFORE UPDATE OF kind trigger on tenants", () => {
    expect(sql).toMatch(
      /create trigger tenants_kind_downgrade_guard\s+before update of kind on tenants/i,
    );
  });

  it("gives activate_tenant_lite an optional p_kind arg defaulting to the safe 'real'", () => {
    expect(sql).toMatch(/drop function if exists activate_tenant_lite\(uuid,\s*text,\s*text,\s*boolean\)/i);
    expect(sql).toMatch(/p_kind text default 'real'/i);
    expect(sql).toMatch(/p_kind not in \('real',\s*'test'\)/i);
    expect(sql).toMatch(/insert into tenants \(slug, display_name, kind\)[\s\S]*?p_kind/i);
  });
});
