import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(DIR, "20261003130000_zavi_managed_operator_db.sql"), "utf8");
const prior = readFileSync(join(DIR, "20260518000001_tenant_members.sql"), "utf8");

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`create or replace function ${name}\\(`, "i"));
  expect(start, `${name} defined`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("end $$;", start);
  return src.slice(start, end + "end $$;".length);
}

describe("20261003130000_zavi_managed_operator_db.sql", () => {
  it("adds the managed marker and the growth-table declaration", () => {
    expect(sql).toMatch(/alter table connector_metadata add column if not exists managed_by text/i);
    expect(sql).toMatch(/alter table tenant_resources add column if not exists metrics_declaration jsonb/i);
  });

  describe("set_operator_db_connection rebuild (founder connect)", () => {
    const next = fnBody(sql, "set_operator_db_connection");
    const old = fnBody(prior, "set_operator_db_connection");

    it("keeps the admin gate, vault rotation and upserts of the latest prior body", () => {
      for (const line of [
        "perform _assert_tenant_admin(p_tenant_id);",
        "delete from vault.secrets where id = v_old;",
        "v_new := vault.create_secret(p_connection_string);",
        "insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at)",
        "schema_map = excluded.schema_map,",
      ]) {
        expect(old).toContain(line);
        expect(next).toContain(line);
      }
    });

    it("keeps the hardened search_path (20260711090514 added pg_temp)", () => {
      expect(next).toMatch(/security definer set search_path = public, vault, pg_temp/i);
    });

    it("stays callable by signed-in founders (and the backend), not anon", () => {
      expect(sql).toMatch(/grant execute on function set_operator_db_connection\(uuid, text, text, jsonb\) to authenticated, service_role/i);
      expect(sql).not.toMatch(/grant execute on function set_operator_db_connection[^;]*anon/i);
    });

    it("a founder connect clears the Zavi marker, so the founder always wins", () => {
      expect(next).toMatch(/managed_by = null;/);
    });

    it("serializes with the managed writer on the same per-tenant lock", () => {
      expect(next).toMatch(/pg_advisory_xact_lock\(hashtext\('operator_db_connection:' \|\| p_tenant_id::text\)\)/);
    });
  });

  describe("set_managed_operator_db_connection", () => {
    const body = fnBody(sql, "set_managed_operator_db_connection");

    it("is service-role only", () => {
      expect(sql).toMatch(/revoke all on function set_managed_operator_db_connection\(uuid, text\) from public, anon, authenticated/i);
      expect(sql).toMatch(/grant execute on function set_managed_operator_db_connection\(uuid, text\) to service_role/i);
      expect(sql).not.toMatch(/grant execute on function set_managed_operator_db_connection[^;]*authenticated/i);
      expect(body).toMatch(/security definer set search_path = public, vault, pg_temp/i);
    });

    it("takes the lock BEFORE checking for a founder connection", () => {
      const lock = body.indexOf("pg_advisory_xact_lock");
      const check = body.indexOf("managed_by is distinct from 'zavi'");
      const write = body.indexOf("vault.create_secret");
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(check);
      expect(check).toBeLessThan(write);
    });

    it("only for a database Zavi provisioned", () => {
      expect(body).toMatch(/resource_kind = 'db' and mode = 'provisioned'/);
    });

    it("never flips a founder row to managed", () => {
      expect(body).toMatch(/where connector_metadata\.managed_by = 'zavi';/);
    });
  });

  describe("set_mapping_confirmed_by_zavi", () => {
    const body = fnBody(sql, "set_mapping_confirmed_by_zavi");

    it("is service-role only", () => {
      expect(sql).toMatch(/revoke all on function set_mapping_confirmed_by_zavi\(uuid, text, jsonb\) from public, anon, authenticated/i);
      expect(sql).toMatch(/grant execute on function set_mapping_confirmed_by_zavi\(uuid, text, jsonb\) to service_role/i);
      expect(body).toMatch(/security definer set search_path = public, pg_temp/i);
    });

    it("refuses a database Zavi did not connect", () => {
      expect(body).toMatch(/slug = 'operator_db' and managed_by = 'zavi'/);
    });

    it("validates against the CURRENT catalog hash and its columns", () => {
      expect(body).toMatch(/p_catalog_hash <> v_current_hash/);
      expect(body).toMatch(/references unknown table/);
      expect(body).toMatch(/references unknown field/);
    });

    it("never overwrites a founder confirmation", () => {
      expect(body).toMatch(/where mapping_confirmed\.confirmed_by is null;/);
    });
  });
});
