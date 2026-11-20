import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIG = join(__dirname, "../../../../../supabase/migrations");
const keys = readFileSync(join(MIG, "20260911222106_company_record_keys.sql"), "utf8");
const rulesRaw = readFileSync(join(MIG, "20260911222107_company_record_rules.sql"), "utf8");
const rules = rulesRaw
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260911222106_company_record_keys.sql", () => {
  it("adds every key the record needs, idempotently", () => {
    for (const key of [
      "industry",
      "location",
      "founded",
      "linkedin_url",
      "instagram_url",
      "facebook_url",
      "x_url",
      "company_story",
    ]) {
      expect(keys).toContain(`add value if not exists '${key}'`);
    }
  });

  it("carries ONLY enum additions (add value cannot share a transaction with its use)", () => {
    expect(keys).not.toMatch(/create or replace function|alter table|begin;/i);
  });
});

describe("20260911222107_company_record_rules.sql", () => {
  it("caps each key for what it holds", () => {
    expect(rules).toMatch(/when 'company_story' then 8000/);
    expect(rules).toMatch(/when 'competitors' then 1300/);
    expect(rules).toMatch(/else 500/);
  });

  it("lets a publish reach every record key except domain", () => {
    const allow = rules.slice(rules.indexOf("if p_key not in ("), rules.indexOf("is not projectable"));
    for (const key of [
      "what_we_sell",
      "who_we_serve",
      "competitors",
      "markets",
      "industry",
      "location",
      "founded",
      "linkedin_url",
      "company_story",
    ]) {
      expect(allow).toContain(`'${key}'`);
    }
    expect(allow).not.toContain("'domain'");
  });

  it("keeps the guards that make a projection safe", () => {
    expect(rules).toMatch(
      /where fact_source_rank\(tenant_fact\.source\) <= fact_source_rank\(excluded\.source\)/,
    );
    expect(rules).toMatch(/source % has no rank/);
    expect(rules).toMatch(/incumbent source % has no rank/);
    expect(rules).toMatch(/return false;/);
    expect(rules).toMatch(/'set-system-projected'/);
  });

  it("keeps the enum-typed source parameter and the service_role-only grant", () => {
    expect(rules).toMatch(/p_source\s+tenant_fact_source/);
    expect(rules).toMatch(
      /revoke execute on function project_tenant_fact\(uuid, tenant_fact_key, text, tenant_fact_source, text\)\s+from public, anon, authenticated;/,
    );
    expect(rules).toMatch(
      /grant execute on function project_tenant_fact\(uuid, tenant_fact_key, text, tenant_fact_source, text\)\s+to service_role;/,
    );
  });

  it("pins search_path with pg_temp", () => {
    expect(rules).toMatch(/set search_path = public, pg_temp/);
  });
});
