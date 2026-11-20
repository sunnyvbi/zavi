import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../../../../supabase/migrations");
const next = readFileSync(resolve(DIR, "20261007160000_extension_claim_kill_switch.sql"), "utf8");
const prev = readFileSync(resolve(DIR, "20261007135000_extension_browser_ops.sql"), "utf8");
const fn = (sql: string) => {
  const start = sql.indexOf("create or replace function public.claim_extension_op(");
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
};

describe("20261007160000_extension_claim_kill_switch", () => {
  it("refuses delivery when extension_browser_control_enabled is explicitly false", () => {
    expect(fn(next)).toContain("(sc.blob ->> 'extension_browser_control_enabled') = 'false'");
  });
  it("is the previous body plus only the kill-switch block", () => {
    const block = fn(next).match(/  -- Kill switch, checked[\s\S]*?end if;\n\n/)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(fn(next).replace(block, "")).toBe(fn(prev));
  });
  it("keeps the service-role-only ACL", () => {
    expect(next).toContain("revoke all on function public.claim_extension_op(uuid, uuid, uuid) from public, anon, authenticated;");
    expect(next).toContain("grant execute on function public.claim_extension_op(uuid, uuid, uuid) to service_role;");
  });
});
