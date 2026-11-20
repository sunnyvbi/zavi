
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG = join(
  __dirname,
  "../../../../../supabase/migrations/20260901030000_bench_application_review.sql",
);
const sql = readFileSync(MIG, "utf-8");

describe("20260901030000_bench_application_review.sql", () => {
  it("seeds bench.application_review as approval + NULL handler + never_auto", () => {
    const insert = sql.slice(sql.indexOf("insert into decision_classes"));
    const stmt = insert.slice(0, insert.indexOf(";") + 1);
    expect(stmt).toMatch(/'bench\.application_review'/);
    expect(stmt).toMatch(/'approval',\s*null,\s*true/);
    expect(stmt).toMatch(/default_autonomy\s*=\s*'approval'/);
    expect(stmt).toMatch(/never_auto\s*=\s*true/);
  });

  it("does NOT register a dispatch handler for the class", () => {
    expect(sql).not.toMatch(/dispatch_handler\s*=\s*'/);
  });

  it("makes one-engagement-per-application a UNIQUE INDEX, not a convention", () => {
    expect(sql).toMatch(
      /create unique index if not exists engagements_application_id_key[\s\S]*?on engagements \(application_id\) where application_id is not null/,
    );
  });

  it("pins pg_temp on both security-definer resolvers", () => {
    const headers = sql.match(/create or replace function[\s\S]*?\$\$/g) ?? [];
    expect(headers).toHaveLength(2);
    for (const h of headers) {
      expect(h).toMatch(/security definer/i);
      expect(h).toMatch(/set search_path = public, pg_temp/i);
    }
  });

  it("keeps the resolvers service_role-only (revoked from public, anon, authenticated)", () => {
    for (const fn of ["bench_resolve_brief(text, uuid)", "bench_resolve_application(uuid)"]) {
      const esc = fn.replace(/[()]/g, (c) => `\\${c}`);
      expect(sql).toMatch(
        new RegExp(`revoke execute on function ${esc} from public, anon, authenticated`),
      );
      expect(sql).toMatch(new RegExp(`grant\\s+execute on function ${esc} to service_role`));
    }
  });

  it("the resolvers are READ-ONLY (a pre-tenant call has no scope to contain a write)", () => {
    const bodies = sql.slice(sql.indexOf("create or replace function"));
    expect(bodies).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from)\b/i);
  });

  it("bench_resolve_brief returns the tenant it resolved", () => {
    expect(sql).toMatch(
      /create or replace function bench_resolve_brief[\s\S]*?returns table \(tenant_id uuid/,
    );
  });
});
