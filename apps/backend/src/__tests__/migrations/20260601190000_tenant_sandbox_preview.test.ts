import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260601190000_tenant_sandbox_preview.sql",
  ),
  "utf-8",
);

describe("20260601190000_tenant_sandbox_preview.sql", () => {
  it("adds the five preview columns additively (idempotent IF NOT EXISTS)", () => {
    expect(sql).toMatch(/add column if not exists preview_url\s+text/i);
    expect(sql).toMatch(/add column if not exists preview_port\s+int/i);
    expect(sql).toMatch(/add column if not exists preview_status\s+text/i);
    expect(sql).toMatch(/add column if not exists preview_last_viewed_at\s+timestamptz/i);
    expect(sql).toMatch(/add column if not exists preview_started_at\s+timestamptz/i);
  });

  it("constrains preview_status to NULL or the four states", () => {
    expect(sql).toMatch(
      /check\s*\(\s*preview_status is null or preview_status in \('starting','live','swapped','dead'\)\s*\)/i,
    );
  });

  it("only ALTERs the existing tenant_sandbox table (no new table)", () => {
    expect(sql).toMatch(/alter table public\.tenant_sandbox/i);
    expect(sql).not.toMatch(/create table/i);
  });

  it("defines set_sandbox_preview(uuid, text, int, text) as security-definer", () => {
    expect(sql).toMatch(
      /create or replace function set_sandbox_preview\(\s*p_id uuid,\s*p_url text,\s*p_port int,\s*p_status text\s*\) returns void/i,
    );
    expect(sql).toMatch(
      /function set_sandbox_preview[\s\S]*?language plpgsql security definer set search_path = public/i,
    );
  });
  it("revokes set_sandbox_preview from public and grants only to service_role", () => {
    expect(sql).toMatch(/revoke all on function set_sandbox_preview\(uuid, text, int, text\) from public/i);
    expect(sql).toMatch(/grant execute on function set_sandbox_preview\(uuid, text, int, text\) to service_role/i);
  });

  it("defines touch_sandbox_preview_viewed(uuid) and only touches a LIVE preview row", () => {
    expect(sql).toMatch(
      /create or replace function touch_sandbox_preview_viewed\(p_id uuid\) returns void/i,
    );
    expect(sql).toMatch(/where id = p_id and preview_status = 'live'/i);
  });
  it("revokes touch_sandbox_preview_viewed from public and grants only to service_role", () => {
    expect(sql).toMatch(/revoke all on function touch_sandbox_preview_viewed\(uuid\) from public/i);
    expect(sql).toMatch(/grant execute on function touch_sandbox_preview_viewed\(uuid\) to service_role/i);
  });

  it("defines clear_sandbox_preview(uuid, text default 'swapped') and nulls the url", () => {
    expect(sql).toMatch(
      /create or replace function clear_sandbox_preview\(\s*p_id uuid,\s*p_final_status text default 'swapped'\s*\) returns void/i,
    );
    expect(sql).toMatch(/preview_url\s*=\s*null/i);
  });
  it("revokes clear_sandbox_preview from public and grants only to service_role", () => {
    expect(sql).toMatch(/revoke all on function clear_sandbox_preview\(uuid, text\) from public/i);
    expect(sql).toMatch(/grant execute on function clear_sandbox_preview\(uuid, text\) to service_role/i);
  });

  it("every RPC pins search_path = public (no privilege-escalation)", () => {
    const count = (sql.match(/security definer set search_path = public/gi) ?? []).length;
    expect(count).toBe(3);
  });
});
