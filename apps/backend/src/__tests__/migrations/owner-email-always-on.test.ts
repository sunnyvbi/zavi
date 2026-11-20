import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260929153000_owner_email_access_always_on.sql",
  ),
  "utf-8",
);

function fnBody(name: string): string {
  const start = SRC.indexOf(`create or replace function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf("$$;", SRC.indexOf("$$", start) + 2);
  return SRC.slice(start, end);
}

describe("20260929153000 — owner email access is always on", () => {
  it("set_email_member_enabled refuses to turn an owner OFF, but still allows ON", () => {
    const body = fnBody("set_email_member_enabled");
    expect(body).toMatch(/if not p_enabled and v_target_role = 'owner' then\s+raise exception 'owner_email_always_on'/);
    expect(body.indexOf("owner_email_always_on")).toBeLessThan(
      body.indexOf("insert into public.tenant_email_member_disabled"),
    );
    expect(body).toContain("raise exception 'admin_only'");
    expect(body).toContain("raise exception 'target_not_a_member'");
  });

  it("the inbound gate and the settings read both exclude owners", () => {
    expect(fnBody("disabled_member_emails")).toMatch(/tu\.role <> 'owner'/);
    expect(fnBody("list_email_member_disabled")).toMatch(/tu\.role <> 'owner'/);
  });

  it("revokes every redefined function from public, anon, authenticated; disabled_member_emails stays service_role only", () => {
    for (const sig of [
      "set_email_member_enabled\\(uuid, boolean\\)",
      "list_email_member_disabled\\(\\)",
      "disabled_member_emails\\(uuid\\)",
    ]) {
      expect(SRC).toMatch(new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`));
    }
    expect(SRC).not.toMatch(/grant execute on function disabled_member_emails\(uuid\) to authenticated/);
    expect(SRC).toMatch(/grant execute on function set_email_member_enabled\(uuid, boolean\) to authenticated;/);
    expect(SRC).toMatch(/grant execute on function list_email_member_disabled\(\) to authenticated;/);
  });

  it("deletes existing OFF rows that belong to an owner", () => {
    expect(SRC).toMatch(
      /delete from tenant_email_member_disabled d\s+using tenant_users tu[\s\S]*tu\.role = 'owner';/,
    );
  });
});
