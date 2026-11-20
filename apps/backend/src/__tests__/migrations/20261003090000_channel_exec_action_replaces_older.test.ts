import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf-8");

const FILE = "20261003090000_channel_exec_action_replaces_older.sql";
const NEW = read(FILE);
const PRIOR = read("20260925060000_channel_action_card_presentation.sql");

function fn(sql: string, name: string): string {
  const i = sql.indexOf(`create or replace function ${name}(`);
  expect(i, `${name} defined`).toBeGreaterThanOrEqual(0);
  const j = sql.indexOf("end $$;", i);
  return sql.slice(i, j + "end $$;".length);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function undo(body: string): string {
  return body
    .replace(/\n +v_obj +text;\n +v_subject text;\n +v_old +uuid;\n +v_replaced int := 0;/, "")
    .replace(/\n+ *-- A newer version of the same change[\s\S]*?\n {4}end loop;\n {2}end if;\n/, "\n")
    .replace(/,\n +'replaced', v_replaced\);/, ");");
}

describe(FILE, () => {
  it("is based on the LATEST prior definition: no migration between them redefines the writer", () => {
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /function (public\.)?record_channel_exec_action\s*\(/i.test(read(f)))
      .sort();
    expect(defs).toEqual([
      "20260919060402_channel_action_exec.sql",
      "20260925060000_channel_action_card_presentation.sql",
      FILE,
      "20261009100200_channel_card_layered_dedupe.sql",
      "20261020160000_uncertain_failed_twin_stays_open.sql",
      "20261110220000_founder_order_authority.sql",
    ]);
  });

  it("the new body is the prior body plus the replace block, and nothing else", () => {
    const before = fn(PRIOR, "record_channel_exec_action");
    const after = fn(NEW, "record_channel_exec_action");
    expect(after).not.toBe(before);
    expect(norm(undo(after))).toBe(norm(before));
  });

  it("keeps the same-run replay dedup ahead of the insert, so a replay replaces nothing", () => {
    const body = fn(NEW, "record_channel_exec_action");
    const replay = body.indexOf("'replayed', true");
    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(body.indexOf("insert into channel_actions"));
    expect(body.indexOf("insert into channel_actions")).toBeLessThan(body.indexOf("update channel_actions"));
  });

  it("retires only an untouched, same-object, same-class card that cannot have moved money, under the UPDATE's row lock", () => {
    const body = fn(NEW, "record_channel_exec_action");
    const upd = norm(body.slice(body.indexOf("update channel_actions"), body.indexOf("returning id\n")));
    for (const clause of [
      "tenant_id = v_tenant",
      "channel_slug = v_channel",
      "exec_class = v_class",
      "id <> v_id",
      "status in ('pending', 'snoozed')",
      "(status = 'pending' or snoozed_until is null or snoozed_until <= now())",
      "(exec_status is null or (exec_status = 'failed' and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown') and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted') and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))",
      "edited_body is null",
      "steps_done = '[]'::jsonb",
      "= v_subject",
      "set status = 'stale'",
    ]) {
      expect(upd).toContain(clause);
    }
    expect(upd).not.toMatch(/google_ads|meta_ads|generated_video|chatgpt_ads/);
    expect(norm(body)).toContain(norm("if v_type in ('update_ad', 'pause_ad') and v_obj is not null then"));
  });

  it("writes one replayable stale_flagged event per retired card and reports the count", () => {
    const body = fn(NEW, "record_channel_exec_action");
    expect(norm(body)).toContain(
      norm(`(v_tenant, v_old, 'stale_flagged', 'channel_run', p_run_id,
         left('Replaced by a newer version: ' || v_title, 1000), 'replaced:' || v_id)
      on conflict (action_id, event_key) do nothing;`),
    );
    expect(norm(body)).toContain(norm("'replaced', v_replaced);"));
  });

  it("keeps security definer, search_path and service-role-only grants", () => {
    expect(NEW.match(/security definer set search_path = public, pg_temp/g)?.length).toBe(1);
    const sig = "record_channel_exec_action(uuid, uuid, jsonb)";
    expect(norm(NEW)).toContain(norm(`revoke all on function ${sig} from public, anon, authenticated;`));
    expect(norm(NEW)).toContain(norm(`grant execute on function ${sig} to service_role;`));
  });
});
