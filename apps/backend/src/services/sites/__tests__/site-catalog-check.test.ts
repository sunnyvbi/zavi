import { describe, it, expect } from "vitest";
import {
  catalogAssertionSql,
  catalogProblems,
  deriveStarterBaseline,
  siteCatalogCheckSql,
  starterBaseline,
} from "../site-catalog-check";
import { starterSql } from "../site-sql-policy";

describe("starter baseline (derived from the starter SQL, never listed by hand)", () => {
  const b = starterBaseline();

  it("finds the starter's functions with their exact bodies, SECURITY DEFINER and pinned search_path", () => {
    const names = b.functions.map((f) => f.name).sort();
    expect(names).toEqual(["handle_new_user", "is_admin"]);
    for (const f of b.functions) {
      expect(f.security_definer).toBe(true);
      expect(f.config).toEqual(['search_path=""']);
      expect(starterSql()).toContain(f.body);
    }
  });

  it("finds the starter's tables, grants, policies and trigger", () => {
    expect([...b.reserved.tables]).toEqual(["profiles"]);
    expect(b.table_grants.profiles).toEqual({ authenticated: ["SELECT"] });
    expect(b.function_grants).toEqual({ is_admin: ["authenticated"], handle_new_user: [] });
    expect(b.policies).toEqual({ profiles: ["profiles_select"] });
    expect(b.triggers).toEqual({ on_auth_user_created: { table: "auth.users", fn: "handle_new_user" } });
  });

  it("follows the starter: a new starter function is checked without touching this module", () => {
    const more = deriveStarterBaseline(
      `${starterSql()}\ncreate or replace function public.is_owner() returns boolean language sql stable security definer set search_path = '' as $$ select false $$;`,
    );
    expect(more.functions.map((f) => f.name)).toContain("is_owner");
    expect(siteCatalogCheckSql(more)).toContain("starter function changed or overloaded: public.is_owner");
  });
});

describe("catalog check SQL", () => {
  const sql = siteCatalogCheckSql();

  it("asks every invariant", () => {
    for (const fragment of [
      "table without row level security",
      "materialized view",
      "view without security_invoker",
      "SECURITY DEFINER function without a pinned search_path",
      "SECURITY DEFINER function the starter does not define",
      "starter function changed or overloaded: public.is_admin",
      "starter function changed or overloaded: public.handle_new_user",
      "starter trigger missing or changed: on_auth_user_created",
      "anon has SELECT on public.profiles",
      "authenticated has UPDATE on public.profiles",
      "anon can execute public.is_admin",
      "authenticated can execute public.handle_new_user",
      "policy the starter does not define on public.profiles",
      "grant option for",
      "can use the platform schema zavi",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).not.toContain("authenticated has SELECT on public.profiles");
    expect(sql).not.toContain("authenticated can execute public.is_admin'");
  });

  it("the assertion raises inside the transaction and refuses an unsafe quote tag", () => {
    const a = catalogAssertionSql("roles", "abcdef0123456789");
    expect(a).toMatch(/^do \$zavi_check_abcdef0123456789\$/);
    expect(a).toContain("raise exception 'zavi catalog check failed: %'");
    expect(a).toContain("database roles, role memberships or role settings changed");
    expect(() => catalogAssertionSql("roles", "x'; drop")).toThrow(/nonce/);
    expect(() => catalogAssertionSql("$zavi_roles_abcdef0123456789$", "abcdef0123456789")).toThrow(/quote tag/);
  });

  it("catalogProblems keeps only problem strings", () => {
    expect(catalogProblems([{ problem: "a" }, { x: 1 }, null, { problem: "" }])).toEqual(["a"]);
  });
});

describe("catalog check: views reaching starter tables (re-review 2 F1)", () => {
  it("asks for views that read a starter table directly or through other views", () => {
    const sql = siteCatalogCheckSql();
    expect(sql).toContain("view that reads a starter table: public.");
    expect(sql).toContain("with recursive deps");
    expect(sql).toMatch(/dep_name in \('profiles'/);
  });
});

