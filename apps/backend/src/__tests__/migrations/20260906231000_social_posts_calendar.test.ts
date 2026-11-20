
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260906231000_social_posts_calendar.sql"),
  "utf-8",
);

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, `function ${name} present`).toBeGreaterThan(-1);
  const end = sql.indexOf("end $$;", start);
  return sql.slice(start, end);
}

describe("20260906231000_social_posts_calendar.sql", () => {
  it("grants the browser read and adds the (tenant_id, scheduled_at) index", () => {
    expect(sql).toMatch(/grant select on social_posts to authenticated;/);
    expect(sql).toMatch(/create index if not exists social_posts_tenant_scheduled_idx\s+on social_posts \(tenant_id, scheduled_at\)/);
  });

  it("both RPCs are security definer with pg_temp pinned, revoked from public, granted to service_role", () => {
    for (const sig of ["social_post_cancel(uuid, uuid)", "social_post_reschedule(uuid, uuid, timestamptz)"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    for (const name of ["social_post_cancel", "social_post_reschedule"]) {
      expect(fnBody(name)).toMatch(/security definer set search_path = public, pg_temp/);
    }
  });

  it("cancel: locks with the claim predicate, flips status ONLY, never raises", () => {
    const body = fnBody("social_post_cancel");
    expect(body).toMatch(/status in \('approved','scheduled'\)\s+for update/);
    expect(body).toMatch(/update social_posts set status = 'cancelled' where id = p_post_id;/);
    expect(body).not.toMatch(/raise/);
    expect(body).toMatch(/return false;/);
    expect(body).toMatch(/tenant_id = p_tenant_id/);
  });

  it("reschedule: refuses a past time, cancels the old row, INSERTs a new one and returns its id", () => {
    const body = fnBody("social_post_reschedule");
    expect(body).toMatch(/p_scheduled_at <= now\(\)/);
    expect(body).toMatch(/errcode = '22023'/);
    expect(body).toMatch(/tenant_id = p_tenant_id/);
    expect(body).toMatch(/update social_posts set status = 'cancelled' where id = v_old\.id;/);
    expect(body).not.toMatch(/update social_posts\s+set[^;]*scheduled_at/i);
    expect(body).toMatch(/insert into social_posts \(/);
    expect(body).toMatch(/returning id into v_new_id;/);
    expect(body).toMatch(/return null;/);
  });

  it("reschedule: new key chains off the OLD key + time; hash uses pg_catalog sha256, not pgcrypto digest", () => {
    const body = fnBody("social_post_reschedule");
    expect(body).toMatch(/sha256\(convert_to\(v_old\.idempotency_key \|\| ':' \|\| v_when, 'UTF8'\)\)/);
    expect(body).toMatch(/sha256\(convert_to\(v_snapshot::text, 'UTF8'\)\)/);
    expect(body).not.toMatch(/digest\(/);
    expect(body).toMatch(/jsonb_build_object\('scheduled_at', v_when\)/);
    expect(body).toMatch(/'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/);
    expect(body).toMatch(/v_old\.transport/);
  });
});
