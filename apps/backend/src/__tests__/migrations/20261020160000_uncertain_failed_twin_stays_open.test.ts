import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf-8");
const FILE = "20261020160000_uncertain_failed_twin_stays_open.sql";
const NEW = read(FILE);
const PRIOR_WRITERS = read("20261009100200_channel_card_layered_dedupe.sql");
const PRIOR_DISPLACE = read("20261009100400_displace_channel_actions_card_lock.sql");

function fn(sql: string, name: string): string {
  const s = sql.indexOf(`create or replace function ${name}(`);
  expect(s, `${name} defined`).toBeGreaterThanOrEqual(0);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1);
}

const tighten = (body: string) =>
  body.replace(
    /exec_status = 'failed'(\s+)and coalesce\(exec_result->>'code', ''\) not in \('exec_partial', 'exec_outcome_unknown'\)/g,
    (_m, ws: string) => `exec_status = 'failed'${ws}and coalesce(exec_result->>'bucket', '') in ('blocked_on_us', 'needs_founder')${ws}and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')`,
  );

describe(FILE, () => {
  it("is the latest definition of all four functions", () => {
    for (const name of ["record_channel_exec_action", "record_channel_run_actions", "chain_channel_action_repeat", "displace_channel_actions"]) {
      const defs = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .filter((f) => read(f).includes(`create or replace function ${name}(`))
        .sort();
      const latest: Record<string, string> = {
        record_channel_exec_action: "20261110220000_founder_order_authority.sql",
        record_channel_run_actions: "20261111090000_untargeted_card_layer1_dedupe.sql",
      };
      expect(defs[defs.length - 1], name).toBe(latest[name] ?? FILE);
    }
  });

  it("each card writer is its prior definition with ONLY the definite-bucket rule added, at every retirement site", () => {
    let sites = 0;
    for (const name of ["record_channel_exec_action", "record_channel_run_actions", "chain_channel_action_repeat"]) {
      const prior = fn(PRIOR_WRITERS, name);
      expect(fn(NEW, name), name).toBe(tighten(prior));
      sites += (fn(NEW, name).match(/in \('blocked_on_us', 'needs_founder'\)/g) ?? []).length;
    }
    expect(sites).toBe(5);
  });

  it("displacement is its prior definition plus exactly one skip for an uncertain failed card", () => {
    const prior = fn(PRIOR_DISPLACE, "displace_channel_actions");
    const now = fn(NEW, "displace_channel_actions");
    const anchor = "       or coalesce(v_row.exec_status, '') in ('queued', 'dispatching')\n";
    const i = now.indexOf(anchor) + anchor.length;
    const added = now.slice(i, now.indexOf("    then", i));
    expect(now.replace(added, "")).toBe(prior);
    expect(added).toContain("not in ('blocked_on_us', 'needs_founder')");
  });

  it("grants are restated: service_role only", () => {
    for (const sig of [
      "record_channel_exec_action(uuid, uuid, jsonb)",
      "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)",
      "chain_channel_action_repeat(uuid, uuid, uuid)",
      "displace_channel_actions(uuid, text, uuid, uuid[], text)",
    ]) {
      expect(NEW).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(NEW).toContain(`grant execute on function ${sig} to service_role;`);
    }
  });
});
