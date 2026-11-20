
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260908190000_unset_whatsapp_thread.sql"),
  "utf-8",
);

describe("20260908190000_unset_whatsapp_thread.sql", () => {
  it("takes the tenant AND the thread id, both required", () => {
    expect(sql).toMatch(
      /create or replace function unset_whatsapp_thread\(\s*p_tenant_id uuid,\s*p_thread_id uuid\s*\)/i,
    );
    expect(sql).toMatch(/if p_tenant_id is null or p_thread_id is null then\s+raise exception/i);
  });

  it("locates the row by tenant + id together — never by id alone", () => {
    expect(sql).toMatch(
      /update whatsapp_threads\s+set status = 'deleted'[\s\S]*?where id = p_thread_id\s+and tenant_id = p_tenant_id\s+and status <> 'deleted'/i,
    );
  });

  it("tombstones the thread (status 'deleted') rather than removing the identity row", () => {
    expect(sql).not.toMatch(/delete from whatsapp_threads/i);
    expect(sql).toMatch(/set status = 'deleted'/i);
  });

  it("clears a pending bind's confirm code so it can never complete later", () => {
    expect(sql).toMatch(/confirm_code = null/i);
    expect(sql).toMatch(/pending_expires_at = null/i);
  });

  it("reports 'not found' as NULL when nothing matched", () => {
    expect(sql).toMatch(/get diagnostics v_updated = row_count;\s+if v_updated = 0 then\s+return null;/i);
  });

  it("clears connector_metadata ONLY when no enabled thread remains, and returns the remaining count", () => {
    expect(sql).toMatch(
      /select count\(\*\) into v_left\s+from whatsapp_threads\s+where tenant_id = p_tenant_id\s+and status = 'enabled'/i,
    );
    expect(sql).toMatch(
      /if v_left = 0 then\s+delete from connector_metadata\s+where tenant_id = p_tenant_id and slug = 'whatsapp';\s+end if;\s+return v_left;/i,
    );
  });

  it("is backend-only (revoked from public)", () => {
    expect(sql).toMatch(/revoke all on function unset_whatsapp_thread\(uuid, uuid\) from public/i);
  });
});
