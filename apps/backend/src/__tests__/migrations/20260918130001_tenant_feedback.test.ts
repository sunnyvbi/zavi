
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260918130001_tenant_feedback.sql"),
  "utf-8",
);

describe("20260918130001_tenant_feedback.sql", () => {
  it("creates the table with a tenant FK that cascades", () => {
    expect(sql).toMatch(/create table tenant_feedback/i);
    expect(sql).toMatch(/tenant_id uuid not null references tenants\(id\) on delete cascade/i);
  });

  it("enables RLS", () => {
    expect(sql).toMatch(/alter table tenant_feedback enable row level security/i);
  });

  it("scopes SELECT to the caller's own tenant memberships", () => {
    expect(sql).toMatch(
      /create policy tenant_feedback_select on tenant_feedback for select to authenticated using \(\s*tenant_id in \(select tenant_id from tenant_users where user_id = auth\.uid\(\)\)/i,
    );
  });

  it("leaves authenticated with NO direct write path — the RPC is the only door", () => {
    expect(sql).toMatch(/revoke insert, update, delete on tenant_feedback from authenticated, anon/i);
    expect(sql).not.toMatch(/for (insert|update|delete) to authenticated/i);
  });

  it("writes through a security-definer RPC with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function submit_tenant_feedback/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public, pg_temp/i);
  });

  it("rejects an unauthenticated caller inside the RPC", () => {
    expect(sql).toMatch(/if v_user_id is null then\s*raise exception 'unauthenticated'/i);
  });

  it("checks tenant_users membership on EVERY write, whatever the tenant came from", () => {
    expect(sql).toMatch(
      /if not exists \(\s*select 1 from tenant_users tu\s*where tu\.tenant_id = v_tenant_id and tu\.user_id = v_user_id\s*\) then\s*raise exception 'unauthorized'/i,
    );
  });

  it("falls back to the profile default only when no tenant was supplied", () => {
    expect(sql).toMatch(/v_tenant_id := p_tenant_id;/i);
    expect(sql).toMatch(/select p\.active_tenant_id into v_tenant_id/i);
  });

  it("caps the body and normalises the attachment list instead of failing the write", () => {
    expect(sql).toMatch(/left\(v_body, 4000\)/i);
    expect(sql).toMatch(/jsonb_typeof\(v_attachments\) <> 'array'/i);
  });

  it("grants execute on the 4-arg signature", () => {
    expect(sql).toMatch(
      /grant execute on function submit_tenant_feedback\(text, jsonb, text, uuid\) to authenticated/i,
    );
  });

  it("stays minimal — no second table and no rollup RPC (pre-launch, zero rows)", () => {
    expect(sql.match(/create table/gi) ?? []).toHaveLength(1);
    expect(sql.match(/create or replace function/gi) ?? []).toHaveLength(1);
  });

  it("is wrapped in a transaction", () => {
    expect(sql.trimStart()).toMatch(/^--/);
    expect(sql).toMatch(/\bbegin;/i);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });
});
