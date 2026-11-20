import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

const MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "20260704013000_growth_diagnosis_guard_schema.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf-8");

function fnBodyOf(name: string): string {
  const re = new RegExp(`create or replace function ${name}\\b`, "i");
  const parts = sql.split(re);
  if (parts.length < 2) return "";
  return parts[1].split(/create or replace function/i)[0] ?? "";
}

describe(
  "20260704013000_growth_diagnosis_guard_schema.sql — E3 guardrails",
  () => {
    describe("catalog_hash (server-computed canonical hash)", () => {
      it("adds catalog_hash column to tenant_db_catalog", () => {
        expect(sql).toMatch(
          /alter table tenant_db_catalog add column if not exists catalog_hash text/i,
        );
      });

      it("backfills existing rows from {dialect,catalog,hints}", () => {
        expect(sql).toMatch(/update tenant_db_catalog\s+set catalog_hash = md5\(/i);
        expect(sql).toMatch(/dialect::text/i);
        expect(sql).toMatch(/coalesce\(catalog, '\{\}'::jsonb\)::text/i);
        expect(sql).toMatch(/coalesce\(hints,\s+'\{\}'::jsonb\)::text/i);
      });
    });

    describe("set_tenant_db_catalog rebuild (clean superset)", () => {
      it("still computes + stores catalog_hash on insert AND update", () => {
        const body = fnBodyOf("set_tenant_db_catalog");
        expect(body).not.toBe("");
        expect(body).toMatch(/md5\(p_dialect \|\| v_catalog::text \|\| v_hints::text\)/i);
        expect(body).toMatch(/insert into tenant_db_catalog[\s\S]*catalog_hash/i);
        expect(body).toMatch(/catalog_hash = excluded\.catalog_hash/i);
      });

      it("stays service-role only — revoked from public, NO authenticated grant", () => {
        expect(sql).toMatch(
          /revoke all on function set_tenant_db_catalog\(uuid, text, jsonb, jsonb, text\) from public/i,
        );
        expect(sql).not.toMatch(
          /grant execute on function set_tenant_db_catalog\(.*to authenticated/i,
        );
      });
    });

    describe("mapping_confirmed table", () => {
      it("is keyed by (tenant_id, catalog_hash) with cascade FK", () => {
        expect(sql).toMatch(/create table if not exists mapping_confirmed/i);
        expect(sql).toMatch(
          /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(/catalog_hash text not null/i);
        expect(sql).toMatch(/confirmed_map jsonb not null/i);
        expect(sql).toMatch(/primary key \(tenant_id, catalog_hash\)/i);
      });

      it("RLS enabled + member-select only, NO write policy", () => {
        expect(sql).toMatch(
          /alter table mapping_confirmed enable row level security/i,
        );
        expect(sql).toMatch(
          /create policy mapping_confirmed_member_select on mapping_confirmed/i,
        );
        expect(sql).not.toMatch(
          /create policy [^;]+ for (insert|update|delete) on mapping_confirmed/i,
        );
      });
    });

    describe("set_mapping_confirmed — USER-CALLABLE confirm-gate write (E3)", () => {
      it("is security-definer with pinned search_path", () => {
        expect(sql).toMatch(
          /create or replace function set_mapping_confirmed[\s\S]{0,200}security definer set search_path = public/i,
        );
      });

      it("uses user-bearer auth + _assert_tenant_admin (NOT the service-role pattern)", () => {
        const body = fnBodyOf("set_mapping_confirmed");
        expect(body).toMatch(/if auth\.uid\(\) is null then/i);
        expect(body).toMatch(/perform _assert_tenant_admin\(p_tenant_id\)/i);
      });

      it("rejects a stale catalog_hash (submitted must equal current)", () => {
        const body = fnBodyOf("set_mapping_confirmed");
        expect(body).toMatch(/from tenant_db_catalog/i);
        expect(body).toMatch(/p_catalog_hash <> v_current_hash/i);
        expect(body).toMatch(/stale catalog_hash/i);
      });

      it("validates every table/field in the map against the CURRENT catalog", () => {
        const body = fnBodyOf("set_mapping_confirmed");
        expect(body).toMatch(/jsonb_each\(p_confirmed_map\)/i);
        expect(body).toMatch(/unknown table/i);
        expect(body).toMatch(/unknown field/i);
        expect(body).toMatch(/jsonb_array_elements\(coalesce\(v_catalog->'tables'/i);
      });

      it("validates the canonical `field` AND every `*_field` column key (codex P1)", () => {
        const body = fnBodyOf("set_mapping_confirmed");
        expect(body).toMatch(/jsonb_each_text\(v_val\)/i);
        expect(body).toMatch(/v_fkey = 'field' or v_fkey ~ '_field\$'/i);
      });

      it("re-confirm stamps confirmed_at = now() (audit freshness, codex P2)", () => {
        const body = fnBodyOf("set_mapping_confirmed");
        expect(body).toMatch(/on conflict \(tenant_id, catalog_hash\)/i);
        expect(body).toMatch(/confirmed_at\s*=\s*now\(\)/i);
      });

      it("revoke-public + grant-authenticated", () => {
        expect(sql).toMatch(
          /revoke all on function set_mapping_confirmed\(uuid, text, jsonb\) from public/i,
        );
        expect(sql).toMatch(
          /grant execute on function set_mapping_confirmed\(uuid, text, jsonb\) to authenticated/i,
        );
      });
    });

    describe("growth_diagnosis_provenance table (metadata + counts ONLY)", () => {
      it("is keyed unique on (tenant_id, run_id, query_id) with cascade FKs", () => {
        expect(sql).toMatch(/create table if not exists growth_diagnosis_provenance/i);
        expect(sql).toMatch(
          /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(
          /run_id\s+uuid not null references agent_runs\(id\) on delete cascade/i,
        );
        expect(sql).toMatch(/unique \(tenant_id, run_id, query_id\)/i);
      });

      it("stores ONLY counts/metadata — no raw-row / raw-label column", () => {
        const tableDdl =
          sql
            .split(/create table if not exists growth_diagnosis_provenance/i)[1]
            ?.split(/\);/)[0] ?? "";
        expect(tableDdl).not.toBe("");
        expect(tableDdl).toMatch(/numerator\s+numeric/i);
        expect(tableDdl).toMatch(/denominator\s+numeric/i);
        expect(tableDdl).toMatch(/row_count\s+bigint/i);
        expect(tableDdl).not.toMatch(/\b(rows|sample|samples|labels|label|reason|reasons|body|payload|values)\b\s+(text|jsonb)/i);
      });

      it("RLS enabled + member-select only, NO write policy", () => {
        expect(sql).toMatch(
          /alter table growth_diagnosis_provenance enable row level security/i,
        );
        expect(sql).toMatch(
          /create policy growth_diagnosis_provenance_member_select on growth_diagnosis_provenance/i,
        );
        expect(sql).not.toMatch(
          /create policy [^;]+ for (insert|update|delete) on growth_diagnosis_provenance/i,
        );
      });
    });

    describe("record_diagnosis_provenance — SERVICE-ROLE only", () => {
      it("is security-definer with pinned search_path", () => {
        expect(sql).toMatch(
          /create or replace function record_diagnosis_provenance[\s\S]{0,400}security definer set search_path = public/i,
        );
      });

      it("rejects a (tenant_id, run_id) pair that doesn't match a real run", () => {
        const body = fnBodyOf("record_diagnosis_provenance");
        expect(body).toMatch(/from agent_runs where id = p_run_id and tenant_id = p_tenant_id/i);
        expect(body).toMatch(/does not belong to tenant/i);
      });

      it("revoked from public + anon + authenticated, NOT granted to authenticated", () => {
        expect(sql).toMatch(
          /revoke all on function record_diagnosis_provenance\([\s\S]*?\) from public, anon, authenticated/i,
        );
        expect(sql).not.toMatch(
          /grant execute on function record_diagnosis_provenance\([^;]*?to authenticated/i,
        );
      });

      it("is granted to service_role (the backend worker caller — codex P1)", () => {
        expect(sql).toMatch(
          /grant execute on function record_diagnosis_provenance\([\s\S]*?to service_role/i,
        );
      });
    });

    describe("get_diagnosis_provenance — server-derived tenant filter (E3)", () => {
      it("is security-definer with pinned search_path", () => {
        expect(sql).toMatch(
          /create or replace function get_diagnosis_provenance[\s\S]{0,600}security definer set search_path = public/i,
        );
      });

      it("derives tenant from the session, NOT from a client argument", () => {
        const body = fnBodyOf("get_diagnosis_provenance");
        expect(body).toMatch(/select active_tenant_id into v_tenant from profiles where user_id = auth\.uid\(\)/i);
        expect(body).toMatch(/perform _assert_tenant_member\(v_tenant\)/i);
        expect(body).toMatch(/where p\.tenant_id = v_tenant/i);
        expect(sql).not.toMatch(
          /create or replace function get_diagnosis_provenance\([^)]*tenant/i,
        );
      });

      it("revoke-public + grant-authenticated", () => {
        expect(sql).toMatch(
          /revoke all on function get_diagnosis_provenance\(uuid, text\) from public/i,
        );
        expect(sql).toMatch(
          /grant execute on function get_diagnosis_provenance\(uuid, text\) to authenticated/i,
        );
      });
    });
  },
);

