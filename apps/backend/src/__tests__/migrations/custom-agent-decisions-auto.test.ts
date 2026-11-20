import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const NEW_FILE = "20260927230000_custom_agent_decisions_auto.sql";
const PRIOR_FILE = "20260717040000_decision_suppression_ledger.sql";

const fnBody = (src: string): string => {
  const start = src.indexOf("create or replace function emit_decision(");
  const end = src.indexOf("end $$;", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + "end $$;".length);
};

const BLOCK_START = "  -- Agent Builder S3b";
const newFn = fnBody(read(NEW_FILE));
const priorFn = fnBody(read(PRIOR_FILE));

describe(NEW_FILE, () => {
  it("is the prior emit_decision exactly, plus the custom-agent block and its variable", () => {
    const blockStart = newFn.indexOf(BLOCK_START);
    const blockEnd = newFn.indexOf("  -- Registry read:", blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    const stripped = (newFn.slice(0, blockStart) + newFn.slice(blockEnd)).replace("  v_custom boolean;\n", "");
    expect(stripped.replace(/\n\n\n/g, "\n\n")).toBe(priorFn.replace(/\n\n\n/g, "\n\n"));
  });

  it("is the latest definition of emit_decision, except the founder-order clamp built on it", () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f > NEW_FILE)
      .filter((f) => /create or replace function (public\.)?emit_decision\(/.test(read(f)));
    expect(later).toEqual(["20261110160000_founder_order_emit_clamp_card_once.sql", "20261110220000_founder_order_authority.sql"]);
  });

  it("only a verified run in THIS tenant is custom; the override comes after the tighten-only one", () => {
    const block = newFn.slice(newFn.indexOf(BLOCK_START), newFn.indexOf("  -- Registry read:"));
    expect(block).toMatch(/_is_custom_agent_run\(p_tenant_id, r\.agent_slug, r\.id, r\.cron_dedupe_key\)/);
    expect(block).toMatch(/r\.tenant_id = p_tenant_id/);
    expect(block).toMatch(/v_autonomy := 'auto'/);
    expect(newFn.indexOf(BLOCK_START)).toBeGreaterThan(newFn.indexOf("p_autonomy_override = 'approval'"));
    expect(newFn.indexOf("'kill_switch'")).toBeLessThan(newFn.indexOf(BLOCK_START));
  });

  it("stays service-role only", () => {
    const sql = read(NEW_FILE);
    expect(sql).toMatch(/revoke all on function emit_decision\(uuid, uuid, text, jsonb, decision_autonomy\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function emit_decision\(uuid, uuid, text, jsonb, decision_autonomy\) to service_role;/);
    expect(newFn).toMatch(/security definer set search_path = public, pg_temp/);
  });
});
