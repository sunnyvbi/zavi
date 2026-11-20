import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261111200000_engineer_founder_mention_gate.sql"), "utf-8");
const PRIOR = readFileSync(join(DIR, "20261105190000_imessage_chat_surface.sql"), "utf-8");

function body(src: string): string {
  const a = src.indexOf("create or replace function _is_engineer_backend_run(");
  const b = src.indexOf("$$;", src.indexOf("$$", a) + 2);
  expect(a).toBeGreaterThan(-1);
  return src.slice(a, b + 3);
}
const STAMP = "\n     and coalesce(p_payload->'founder_direct_agent_mention', 'false'::jsonb) <> 'true'::jsonb";

describe("20261111200000_engineer_founder_mention_gate.sql", () => {
  it("is the 20261105190000 body plus exactly the founder-mention stamp", () => {
    const next = body(SQL);
    expect(next).toContain(STAMP);
    expect(next.replace(STAMP, "")).toBe(body(PRIOR));
  });

  it("stays service-role only", () => {
    expect(SQL).toMatch(/revoke all on function _is_engineer_backend_run\(text, uuid, text, jsonb\) from public, anon, authenticated;/);
    expect(SQL).not.toMatch(/to (anon|authenticated)\b/);
  });
});
