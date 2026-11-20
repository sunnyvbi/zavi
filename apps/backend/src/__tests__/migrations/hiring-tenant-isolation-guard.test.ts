import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

const ALL_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

const DEFINES_RPC = /create or replace function set_operator_decision\b/i;

const rpcDefiners = ALL_SQL.filter((m) => DEFINES_RPC.test(m.sql));

const winning = rpcDefiners[rpcDefiners.length - 1];

function winningRpcBody(): string {
  const from = winning.sql.search(DEFINES_RPC);
  const rest = winning.sql.slice(from);
  const end = rest.indexOf("$$;");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("hiring surface — tenant-isolation guardrails (static SQL)", () => {
  it("some migration actually defines set_operator_decision", () => {
    expect(rpcDefiners.length).toBeGreaterThan(0);
  });

  describe("set_operator_decision — browser-reachable security-definer RPC", () => {
    it("is security-definer with a pinned search_path", () => {
      const body = winningRpcBody();
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path\s*=/i);
    });

    it("enforces tenant membership via auth.uid() before it writes", () => {
      const body = winningRpcBody();
      expect(body).toMatch(/from tenant_users\b/i);
      expect(body).toMatch(/auth\.uid\(\)/i);
      expect(body).toMatch(/not_a_member/i);

      const membershipAt = body.search(/not_a_member/i);
      const updateAt = body.search(/update applications set/i);
      expect(membershipAt).toBeGreaterThan(-1);
      expect(updateAt).toBeGreaterThan(-1);
      expect(membershipAt).toBeLessThan(updateAt);
    });

    it("revokes execute from public and grants only to authenticated", () => {
      expect(winning.sql).toMatch(
        /revoke all on function set_operator_decision\(uuid, text\) from public/i,
      );
      expect(winning.sql).toMatch(
        /grant execute on function set_operator_decision\(uuid, text\) to authenticated/i,
      );
      expect(winning.sql).not.toMatch(
        /grant execute on function set_operator_decision\(uuid, text\) to (public|anon)\b/i,
      );
    });
  });

  describe("hiring tables — RLS enabled + membership-scoped select", () => {
    const TABLES = ["roles", "applications", "application_messages"] as const;

    for (const table of TABLES) {
      it(`${table}: RLS is enabled`, () => {
        const enabled = ALL_SQL.some((m) =>
          new RegExp(`alter table ${table} enable row level security`, "i").test(m.sql),
        );
        expect(enabled).toBe(true);
      });

      it(`${table}: its select policy is scoped through tenant_users`, () => {
        const owner = ALL_SQL.find((m) =>
          new RegExp(`create policy \\w+ on ${table}\\b`, "i").test(m.sql),
        );
        expect(owner).toBeDefined();
        const from = owner!.sql.search(
          new RegExp(`create policy \\w+ on ${table}\\b`, "i"),
        );
        const rest = owner!.sql.slice(from);
        const nextIdx = rest.slice(1).search(/create (policy|table)\b/i);
        const policy = nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1);
        expect(policy).toMatch(/from tenant_users\b/i);
        expect(policy).not.toMatch(/using\s*\(\s*true\s*\)/i);
        expect(policy).not.toMatch(/using\s*\(\s*true\s+or\b/i);
        expect(policy).not.toMatch(/\bor\s+true\b/i);
      });
    }
  });
});
