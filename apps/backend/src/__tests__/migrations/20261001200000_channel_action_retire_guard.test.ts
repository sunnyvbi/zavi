import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf-8");

const FILE = "20261001200000_channel_action_retire_guard.sql";
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
  let b = body
    .replace(/\n +v_kept_open uuid\[\] := '\{\}';\n +v_refused +int := 0;/, "")
    .replace(/\n +-- Runs BEFORE the actions[\s\S]*?supersede path's and the model's own\./, "")
    .replace(
      /\n +and \(status = 'pending' or snoozed_until is null or snoozed_until <= now\(\)\)\n +and exec_class is null\n +and edited_body is null\n +and steps_done = '\[\]'::jsonb/,
      "",
    )
    .replace(/\n +-- Refused while still open:[\s\S]*?v_kept_open := v_kept_open \|\| \(v_s->>'action_id'\)::uuid;\n +end if;/, "")
    .replace(/\n +-- Its old card was flagged stale and refused[\s\S]*?v_refused := v_refused \+ 1;\n +continue;\n +end if;/, "")
    .replace(/\n +'replacements_refused', v_refused,/, "");
  const s0 = b.indexOf("  -- 3. Stale flags");
  const s1 = b.indexOf("  -- 2. Actions");
  expect(s0).toBeGreaterThan(0);
  expect(s1).toBeGreaterThan(s0);
  const stale = b.slice(s0, s1);
  b = b.slice(0, s0) + b.slice(s1);
  const r = b.indexOf("  return jsonb_build_object(\n    'inserted'");
  return b.slice(0, r) + stale + b.slice(r);
}

describe(FILE, () => {
  it("is based on the LATEST prior definition: no migration between it and this one redefines the writer", () => {
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /function (public\.)?record_channel_run_actions\s*\(/i.test(read(f)))
      .sort();
    expect(defs).toEqual([
      "20260919035832_channel_actions.sql",
      "20260925060000_channel_action_card_presentation.sql",
      FILE,
      "20261009100200_channel_card_layered_dedupe.sql",
      "20261020160000_uncertain_failed_twin_stays_open.sql",
      "20261111090000_untargeted_card_layer1_dedupe.sql",
    ]);
  });

  it("the new body is the prior body plus the retire guard, and nothing else", () => {
    const before = fn(PRIOR, "record_channel_run_actions");
    const after = fn(NEW, "record_channel_run_actions");
    expect(after).not.toBe(before);
    expect(norm(undo(after))).toBe(norm(before));
  });

  it("retires only an open, non-executable, untouched card, under the UPDATE's row lock", () => {
    const body = fn(NEW, "record_channel_run_actions");
    const upd = body.slice(body.indexOf("update channel_actions"), body.indexOf("returning id into v_target"));
    for (const clause of [
      "tenant_id = v_tenant",
      "channel_slug = v_channel",
      "status in ('pending', 'snoozed')",
      "exec_status is distinct from 'queued'",
      "exec_status is distinct from 'dispatching'",
      "(status = 'pending' or snoozed_until is null or snoozed_until <= now())",
      "exec_class is null",
      "edited_body is null",
      "steps_done = '[]'::jsonb",
    ]) {
      expect(norm(upd)).toContain(clause);
    }
  });

  it("decides retirement before any insert, and skips a replacement whose old card stayed", () => {
    const body = fn(NEW, "record_channel_run_actions");
    expect(body.indexOf("update channel_actions")).toBeLessThan(body.indexOf("insert into channel_actions"));
    expect(norm(body)).toContain(norm("if v_repeat is not null and v_repeat = any(v_kept_open) then"));
  });

  it("keeps security definer, search_path and service-role-only grants", () => {
    expect(NEW.match(/security definer set search_path = public, pg_temp/g)?.length).toBe(1);
    const sig = "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)";
    expect(norm(NEW)).toContain(norm(`revoke all on function ${sig} from public, anon, authenticated;`));
    expect(norm(NEW)).toContain(norm(`grant execute on function ${sig} to service_role;`));
  });
});
