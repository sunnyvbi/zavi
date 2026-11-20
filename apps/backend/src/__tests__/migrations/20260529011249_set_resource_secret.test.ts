import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260529011249_set_resource_secret.sql"),
  "utf-8",
);

describe("20260529011249_set_resource_secret.sql", () => {
  it("is a security-definer vault writer, service-role only", () => {
    expect(sql).toMatch(/create or replace function public\.set_resource_secret\(/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public, vault/i);
    expect(sql).toMatch(/grant execute on function public\.set_resource_secret\(uuid, text, text, text\) to service_role/i);
    expect(sql).not.toMatch(/to authenticated/i);
  });

  it("mirrors the delete-old → create-new → upsert-mapping vault pattern", () => {
    expect(sql).toMatch(/delete from vault\.secrets where id = v_old_id/i);
    expect(sql).toMatch(/v_new_id := vault\.create_secret\(p_value\)/i);
    expect(sql).toMatch(/insert into public\.secrets \(tenant_id, key, vault_secret_id\)/i);
  });

  it("validates resource_kind + key shape + value length", () => {
    expect(sql).toMatch(/resource_kind not in \('repo','hosting','db','stripe','email','ads','domain'\)/i);
    expect(sql).toMatch(/\^\[a-zA-Z0-9\._-\]\+\$/);
    expect(sql).toMatch(/value length out of range/i);
  });
});
