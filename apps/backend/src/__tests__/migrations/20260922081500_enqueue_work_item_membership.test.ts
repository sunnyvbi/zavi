import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260922081500_enqueue_work_item_membership_for_every_source.sql"),
  "utf-8",
);
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("enqueue_work_item membership (20260922081500)", () => {
  it("a JWT caller may only name a source a person starts", () => {
    expect(CODE).toMatch(/if p_source not in \('chat', 'manual'\) then/);
    expect(CODE).toMatch(/may only be enqueued by the server[\s\S]{0,80}42501/);
  });

  it("membership is checked for every source a JWT caller can name, not just two", () => {
    const guard = CODE.slice(CODE.indexOf("auth.role() is distinct from 'service_role'"));
    const check = guard.indexOf("tenant_users");
    const sourceBranch = guard.indexOf("p_source not in");
    expect(check).toBeGreaterThan(-1);
    expect(sourceBranch).toBeLessThan(check);
    expect(CODE).not.toMatch(/if p_source in \('chat', 'manual'\) then\s+if not exists/);
  });

  it("pins pg_temp in the search_path, which the body it was copied from did not", () => {
    expect(CODE).toMatch(/security definer set search_path = public, pg_temp/);
  });

  it("keeps the service-role path and the e2b lane clamp", () => {
    expect(CODE).toMatch(/auth\.role\(\) is distinct from 'service_role'/);
    expect(CODE).toMatch(/v_lane := 'e2b';/);
  });

  it("keeps the dedupe-key conflict handling the callers rely on", () => {
    expect(CODE).toMatch(/on conflict \(tenant_id, agent_slug, dedupe_key\)/);
    expect(CODE).toMatch(/where dedupe_key is not null and status in \('pending', 'leased'\)/);
  });

  it("closes the sibling door's ACL too", () => {
    expect(CODE).toMatch(/revoke all on function ingest_and_enqueue_work\([\s\S]*?\) from public, anon, authenticated;/);
    expect(CODE).toMatch(/grant execute on function ingest_and_enqueue_work\([\s\S]*?\) to service_role;/);
  });

  it("re-states the grant so the tightened body keeps the same reach", () => {
    expect(CODE).toMatch(/revoke all on function enqueue_work_item\([^)]*\) from public;/);
    expect(CODE).toMatch(/grant execute on function enqueue_work_item\([^)]*\) to authenticated, service_role;/);
  });
});
