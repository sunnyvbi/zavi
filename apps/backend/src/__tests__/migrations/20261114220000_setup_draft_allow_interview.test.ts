import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const prior = readFileSync(join(dir, "20260924130200_setup_draft_admission_bridge.sql"), "utf8");
const sql = readFileSync(join(dir, "20261114220000_setup_draft_allow_interview.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("20261114220000 setup draft allows interview", () => {
  it("adds only `interview` to the payload whitelist", () => {
    const next = fnOf(sql, "enqueue_setup_draft");
    expect(next).toMatch(/k not in \('stage', 'origin', 'research', 'past_work', 'interview'\)/);
    const widened = norm(fnOf(prior, "enqueue_setup_draft")).replace(
      "'research', 'past_work')",
      "'research', 'past_work', 'interview')",
    );
    expect(norm(next)).toBe(widened);
  });
  it("keeps the function service-role only", () => {
    expect(sql).toMatch(/revoke all on function enqueue_setup_draft\(uuid, text, jsonb, int\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function enqueue_setup_draft\(uuid, text, jsonb, int\) to service_role;/);
  });
});
