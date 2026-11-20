import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260520170758_fix_connection_rpcs_vault_delete.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf-8");
const code = sql.replace(/--.*$/gm, "");

const RPCS = [
  "set_meta_ads_connection",
  "set_google_ads_connection",
  "set_stripe_connection",
  "set_email_connection",
];

describe("20260520170758_fix_connection_rpcs_vault_delete.sql — static guards", () => {
  it("re-creates all four connection RPCs", () => {
    for (const fn of RPCS) {
      expect(sql).toMatch(new RegExp(`create or replace function ${fn}\\s*\\(`, "i"));
    }
  });

  it("contains NO vault.delete_secret call — the load-bearing fix", () => {
    expect(code).not.toMatch(/vault\.delete_secret/);
  });

  it("rotates secrets via the version-stable vault.secrets table delete", () => {
    expect(sql).toMatch(/delete from vault\.secrets where id =/i);
  });

  it("keeps each function security-definer with the vault search_path", () => {
    const matches = sql.match(
      /security definer set search_path = public, vault/gi,
    );
    expect(matches?.length).toBe(RPCS.length);
  });

  it("re-applies the public revoke on every re-created function", () => {
    for (const fn of RPCS) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\(`, "i"));
    }
  });
});
