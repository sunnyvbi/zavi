import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260921120153_admin_action_counts_rpc.sql"),
  "utf-8",
);

describe("admin_action_counts RPC (20260921120153)", () => {
  it("is a security definer function with a pinned search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.admin_action_counts/i);
    expect(SQL).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });

  it("revokes execute from public/anon/authenticated and grants only service_role", () => {
    expect(SQL).toMatch(
      /revoke execute on function public\.admin_action_counts\(text, int\) from public, anon, authenticated/i,
    );
    expect(SQL).toMatch(/grant execute on function public\.admin_action_counts\(text, int\) to service_role/i);
  });

  it("real scope drops test/shell tenants and the three dogfood slugs", () => {
    expect(SQL).toMatch(/coalesce\(t\.kind, 'real'\) = 'real'/);
    expect(SQL).toMatch(/'upcar-ai', 'upcar-private', 'apna-tutor-dogfood'/);
  });

  it("test scope is exactly the complement of real, not a second copy of it", () => {
    const real = /else\s+coalesce\(t\.kind, 'real'\) = 'real'/;
    const test = /when 'test' then not \(coalesce\(t\.kind, 'real'\) = 'real'/;
    expect(SQL).toMatch(real);
    expect(SQL).toMatch(test);
  });

  it("dates a published post by its succeeded publish attempt, never by updated_at", () => {
    expect(SQL).toMatch(/from public\.social_publish_attempts a[\s\S]{0,120}a\.status = 'succeeded'/);
    expect(SQL).not.toMatch(/select p\.tenant_id, p\.updated_at/);
  });

  it("counts every person-started trigger as person-started", () => {
    for (const t of ["chat", "slack", "teams", "email", "mcp", "manual", "telegram", "discord", "whatsapp", "playbook"]) {
      expect(SQL).toMatch(new RegExp(`'${t}'`));
    }
    expect(SQL).toMatch(/'discord', 'whatsapp', 'playbook'/);
  });

  it("the launch-video preview filter is NULL-safe on agent_slug", () => {
    expect(SQL).toMatch(
      /f\.agent_slug is distinct from 'launch-video-public' or f\.filename = 'hd\.mp4'/,
    );
    expect(SQL).not.toMatch(/not \(f\.agent_slug = 'launch-video-public'/);
  });

  it("never counts seeded onboarding runs", () => {
    expect(SQL.match(/agent_definition_hash is distinct from 'seed-synthetic'/g)?.length).toBe(2);
  });

  it("reads agent_run_events only by run id, never by scanning it", () => {
    const refs = SQL.match(/from public\.agent_run_events e[\s\S]{0,80}/g) ?? [];
    const joins = SQL.match(/join public\.agent_run_events e on e\.agent_run_id = /g) ?? [];
    for (const r of refs) expect(r).toMatch(/e\.agent_run_id = /);
    expect(refs.length + joins.length).toBeGreaterThan(0);
  });
});
