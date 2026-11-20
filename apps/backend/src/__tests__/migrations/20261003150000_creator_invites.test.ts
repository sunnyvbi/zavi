
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261003150000_creator_invites.sql"),
  "utf8",
).toLowerCase();

const fnBody = (name: string): string => {
  const start = sql.indexOf(`function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", start));
};

describe("creator_invites migration", () => {
  it("is service-role only: RLS on, no policies, privileges revoked", () => {
    expect(sql).toMatch(/alter table public\.creator_invites enable row level security/);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toMatch(/revoke all on public\.creator_invites from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on public\.creator_invite_status from public, anon, authenticated/);
  });

  it("every security-definer function pins pg_temp and is revoked from public", () => {
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(fns.length).toBe(5);
    for (const name of fns) {
      expect(fnBody(name)).toMatch(/security definer\s+set search_path = public, pg_temp/);
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`));
    }
  });

  it("sends one email per creator: no reminder function or columns exist", () => {
    expect(sql).not.toMatch(/nudge/);
  });

  it("one invite per address, case-insensitive", () => {
    expect(sql).toMatch(/unique index if not exists creator_invites_email_key\s+on public\.creator_invites \(lower\(email\)\) where email is not null/);
  });

  it("the invite stamp only moves a row nobody has invited, held, linked or opted out", () => {
    const body = fnBody("creator_invite_stamp");
    for (const clause of [
      "ci.email is not null",
      "ci.hold_reason is null",
      "ci.human_member_id is null",
      "ci.claimed_at is null",
      "ci.member_deleted_at is null",
      "ci.unsubscribed_at is null",
      "ci.bounced_at is null",
      "else ci.invited_at is null",
    ]) expect(body).toContain(clause);
  });

  it("a deleted creator is scrubbed BEFORE the FK unlinks them, keeping the email as a stub", () => {
    expect(sql).toMatch(/before delete on public\.human_members/);
    const body = fnBody("creator_invite_scrub_deleted_member");
    expect(body).toContain("member_deleted_at = now()");
    expect(body).toContain("source_key = 'deleted:' || ci.id::text");
    expect(body).not.toMatch(/\bemail\s*=/);
  });

  it("the status view reads approval live and lets a hold show before 'no email'", () => {
    const view = sql.slice(sql.indexOf("create or replace view public.creator_invite_status"));
    expect(view).toContain("security_invoker = true");
    expect(view.indexOf("then 'held'")).toBeGreaterThan(-1);
    expect(view.indexOf("then 'held'")).toBeLessThan(view.indexOf("then 'no_email'"));
    expect(view).toContain("when m.vetting_state = 'approved' then 'completed'");
    expect(view.indexOf("then 'deleted'")).toBeGreaterThan(-1);
    expect(view.indexOf("then 'deleted'")).toBeLessThan(view.indexOf("then 'completed'"));
  });
});
