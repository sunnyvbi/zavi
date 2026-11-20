import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20260924130100_document_import.sql"), "utf8");
const prior = readFileSync(join(dir, "20260712120000_onboarding_readiness_p1.sql"), "utf8");

describe("20260924130100_document_import", () => {
  it("widens tenant_document.status with 'imported'", () => {
    expect(sql).toMatch(/drop constraint if exists tenant_document_status_check/);
    expect(sql).toMatch(/check \(status in \('approved', 'archived', 'imported'\)\)/);
  });
  it("adds the extraction column", () => {
    expect(sql).toMatch(/add column if not exists extraction jsonb/);
  });
  it("imported rows and objects are owner/admin only; other files keep member access", () => {
    expect(sql).toMatch(/create policy tenant_document_member_select on tenant_document[\s\S]*?tenant_document\.status <> 'imported' or tu\.role in \('owner', 'admin'\)/);
    const storagePolicy = sql.slice(sql.indexOf("create policy tenant_documents_member_select on storage.objects"));
    expect(storagePolicy).toMatch(/tu\.role in \('owner', 'admin'\)\s+or exists \(\s*select 1 from tenant_document d\s+where d\.storage_path = storage\.objects\.name\s+and d\.tenant_id = tu\.tenant_id\s+and d\.status <> 'imported'/);
    expect(storagePolicy.slice(0, storagePolicy.indexOf(");"))).not.toMatch(/not exists/);
  });
  it("keeps every prior memory_note source and adds document_import", () => {
    const list = (s: string) => s.slice(s.indexOf("memory_note_source_check check ("), s.indexOf(");", s.indexOf("memory_note_source_check check (")));
    const before = [...list(prior).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const after = [...list(sql).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const s of before) expect(after).toContain(s);
    expect(after).toContain("document_import");
  });
});
