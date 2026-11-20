import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112100000_approve_channel_action_email_source.sql";
const PRIOR = "20261031190300_email_card_approve_choke_point.sql";
const fnOf = (file: string) => {
  const sql = readFileSync(join(dir, file), "utf8");
  const start = sql.indexOf("create or replace function approve_channel_action(");
  const end = sql.indexOf("to service_role;", start);
  return sql.slice(start, end).split("\n");
};
const OLD_LINE = "  if p_source is not null and p_source not in ('staff', 'cgo') then";
const NEW_LINE = "  if p_source is not null and p_source not in ('staff', 'cgo', 'email') then";

describe(FILE, () => {
  it("rebuilds from the latest prior definition", () => {
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /create\s+or\s+replace\s+function\s+(public\.)?approve_channel_action\s*\(/i.test(readFileSync(join(dir, f), "utf8")))
      .sort();
    const at = defs.indexOf(FILE);
    expect(defs.slice(at - 1, at + 1)).toEqual([PRIOR, FILE]);
  });

  it("is the prior definition with only the allowed sources widened to 'email'", () => {
    const prior = fnOf(PRIOR);
    const next = fnOf(FILE);
    expect(prior).toContain(OLD_LINE);
    expect(next.length).toBe(prior.length);
    expect(next.map((l) => (l === NEW_LINE ? OLD_LINE : l))).toEqual(prior);
    expect(next.filter((l) => l === NEW_LINE)).toHaveLength(1);
  });

  it("keeps an email approval a founder event, never 'system'", () => {
    const next = fnOf(FILE).join("\n");
    expect(next).toContain("case when p_source = 'cgo' then 'system' else 'founder' end");
  });
});
