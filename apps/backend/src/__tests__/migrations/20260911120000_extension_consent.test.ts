
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260911120000_extension_consent.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const FNS = [
  ["grant_extension_consent", "uuid, uuid, text"],
  ["revoke_extension_consent", "uuid, uuid"],
] as const;

describe("20260911120000_extension_consent.sql", () => {
  it("creates the table with the fields consent is judged on", () => {
    expect(code).toMatch(/create table if not exists extension_consent/i);
    for (const col of ["tenant_id", "user_id", "version", "granted_at", "revoked_at"]) {
      expect(code, `missing column ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(code).toMatch(/primary key \(tenant_id, user_id\)/i);
  });

  it("cascades away with the tenant and the user", () => {
    expect(code).toMatch(/tenant_id uuid not null references tenants\(id\) on delete cascade/i);
    expect(code).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/i);
  });

  it("turns RLS on and lets a person read only their OWN row", () => {
    expect(code).toMatch(/alter table extension_consent enable row level security/i);
    const policy = code.slice(code.indexOf("create policy extension_consent_self_select"));
    expect(policy).toMatch(/user_id = auth\.uid\(\)/);
    expect(policy).toMatch(/from tenant_users tu/);
  });

  it("makes the table read-only to clients — every write must go through an RPC", () => {
    expect(code).toMatch(
      /revoke insert, update, delete on extension_consent from anon, authenticated/i,
    );
    expect(code).toMatch(/grant select on extension_consent to authenticated/i);
  });

  for (const [fn, args] of FNS) {
    describe(fn, () => {
      const body = () => {
        const start = code.indexOf(`create or replace function ${fn}(`);
        expect(start).toBeGreaterThan(-1);
        const next = code.indexOf("create or replace function", start + 1);
        return code.slice(start, next === -1 ? undefined : next);
      };

      it("is security definer with a pinned search_path INCLUDING pg_temp", () => {
        expect(body()).toMatch(/security definer set search_path = public, pg_temp/i);
      });

      it("is revoked from public/anon/authenticated and granted to service_role", () => {
        expect(code).toMatch(
          new RegExp(
            `revoke all on function ${fn}\\(${args}\\)\\s+from public, anon, authenticated`,
            "i",
          ),
        );
        expect(code).toMatch(
          new RegExp(`grant execute on function ${fn}\\(${args}\\)\\s+to service_role`, "i"),
        );
      });

      it("refuses a null tenant or a null user", () => {
        expect(body()).toMatch(/p_tenant_id is null/i);
        expect(body()).toMatch(/p_user_id is null/i);
      });

      it("scopes every write by BOTH tenant_id and user_id", () => {
        const b = body();
        expect(b).toMatch(/tenant_id/);
        expect(b).toMatch(/user_id/);
      });
    });
  }

  it("grant re-checks membership itself, as the last line of defence", () => {
    const b = code.slice(code.indexOf("create or replace function grant_extension_consent("));
    expect(b).toMatch(/from tenant_users tu/);
    expect(b).toMatch(/not a member of tenant/);
  });

  it("grant stores the version it was given and clears any prior revocation", () => {
    const b = code.slice(
      code.indexOf("create or replace function grant_extension_consent("),
      code.indexOf("create or replace function revoke_extension_consent("),
    );
    expect(b).toMatch(/on conflict \(tenant_id, user_id\) do update/i);
    expect(b).toMatch(/version = excluded\.version/);
    expect(b).toMatch(/revoked_at = null/);
    expect(b).toMatch(/granted_at = excluded\.granted_at/);
  });

  it("revoke is idempotent — it never moves an existing revoked_at", () => {
    const b = code.slice(code.indexOf("create or replace function revoke_extension_consent("));
    expect(b).toMatch(/revoked_at = coalesce\(revoked_at, now\(\)\)/i);
  });

  it("revoke does NOT try to strip page content in SQL", () => {
    const b = code.slice(code.indexOf("create or replace function revoke_extension_consent("));
    expect(b).not.toMatch(/agent_runs/);
  });
});
