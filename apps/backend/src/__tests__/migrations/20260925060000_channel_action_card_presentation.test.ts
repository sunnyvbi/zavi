import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf-8");

const NEW = read("20260925060000_channel_action_card_presentation.sql");
const RUN_SRC = read("20260919035832_channel_actions.sql");
const EXEC_SRC = read("20260919060402_channel_action_exec.sql");

function fn(sql: string, name: string): string {
  const i = sql.indexOf(`create or replace function ${name}(`);
  expect(i, `${name} defined`).toBeGreaterThanOrEqual(0);
  const j = sql.indexOf("end $$;", i);
  return sql.slice(i, j + "end $$;".length);
}

function stripAdditions(body: string): string {
  return body
    .replace(/\n +v_kind +text;\n +v_primary +text;\n +v_done +text;\n +v_howto +jsonb;/, "")
    .replace(/\n+ *-- The card's words[\s\S]*?end if;\n *if jsonb_typeof\(v_howto\)[\s\S]*?end if;\n/, "\n")
    .replace(/,\n +card_kind, primary_label, done_label, how_to\)/, ")")
    .replace(/,\n +v_kind, v_primary, v_done, v_howto\)/, ")");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("20260925060000_channel_action_card_presentation.sql", () => {
  it("record_channel_run_actions is its only prior body plus the four columns", () => {
    const before = fn(RUN_SRC, "record_channel_run_actions");
    const after = fn(NEW, "record_channel_run_actions");
    expect(after).not.toBe(before);
    expect(norm(stripAdditions(after))).toBe(norm(before));
  });

  it("record_channel_exec_action is its only prior body plus the four columns", () => {
    const before = fn(EXEC_SRC, "record_channel_exec_action");
    const after = fn(NEW, "record_channel_exec_action");
    expect(after).not.toBe(before);
    expect(norm(stripAdditions(after))).toBe(norm(before));
  });

  it("the exec dedup still compares exec_class and exec_payload only", () => {
    const after = fn(NEW, "record_channel_exec_action");
    expect(norm(after)).toContain(
      norm(`where run_id = p_run_id
     and tenant_id = v_tenant
     and exec_class = v_class
     and exec_payload = v_payload
   limit 1;`),
    );
    const dedup = after.slice(after.indexOf("select id into v_id"), after.indexOf("limit 1;"));
    expect(dedup).not.toMatch(/card_kind|primary_label|how_to/);
  });

  it("no other migration redefines either writer", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /function (public\.)?record_channel_(run_actions|exec_action)\s*\(/i.test(read(f)));
    expect(defs.sort()).toEqual([
      "20260919035832_channel_actions.sql",
      "20260919060402_channel_action_exec.sql",
      "20260925060000_channel_action_card_presentation.sql",
      "20261001200000_channel_action_retire_guard.sql",
      "20261003090000_channel_exec_action_replaces_older.sql",
      "20261009100200_channel_card_layered_dedupe.sql",
      "20261020160000_uncertain_failed_twin_stays_open.sql",
      "20261110220000_founder_order_authority.sql",
      "20261111090000_untargeted_card_layer1_dedupe.sql",
    ]);
  });

  it("every writer stays service-role only", () => {
    for (const sig of [
      "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)",
      "record_channel_exec_action(uuid, uuid, jsonb)",
      "set_channel_action_steps(uuid, uuid, jsonb, uuid)",
    ]) {
      expect(norm(NEW)).toContain(norm(`revoke all on function ${sig} from public, anon, authenticated;`));
      expect(norm(NEW)).toContain(norm(`grant execute on function ${sig} to service_role;`));
    }
    expect(NEW.match(/security definer set search_path = public, pg_temp/g)?.length).toBe(3);
  });

  it("set_channel_action_steps re-derives the tenant from the row and refuses mid-execution", () => {
    const body = fn(NEW, "set_channel_action_steps");
    expect(body).toMatch(/for update/);
    expect(body).toMatch(/v_row\.tenant_id is distinct from p_tenant_id/);
    expect(body).toMatch(/exec_status in \('queued', 'dispatching'\)/);
    expect(body).toMatch(/status not in \('pending', 'snoozed'\)/);
    expect(body).toMatch(/'invalid_steps'/);
  });

  it("columns are constrained: a known kind, bounded labels, bounded arrays", () => {
    expect(NEW).toMatch(/card_kind in\s*\('executes','post','plan','message','ad_manual','copy_to_site','task'\)/);
    expect(NEW).toMatch(/char_length\(primary_label\) between 1 and 60/);
    expect(NEW).toMatch(/jsonb_typeof\(how_to\) = 'array' and jsonb_array_length\(how_to\) <= 12/);
    expect(NEW).toMatch(/jsonb_typeof\(steps_done\) = 'array' and jsonb_array_length\(steps_done\) <= 12/);
  });

  it("rebuilds the open-actions view verbatim from its latest definition, so a.* carries the new columns", () => {
    const LATEST = read("20260925041243_channel_plans_not_open_actions.sql");
    const view = (sql: string) => {
      const i = sql.indexOf("create or replace view public.customer_visible_open_channel_actions");
      return norm(sql.slice(i, sql.indexOf(";", i) + 1));
    };
    expect(view(NEW)).toBe(view(LATEST));
    const later = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f.slice(0, 14) > "20260925060000")
      .filter((f) => /view (public\.)?customer_visible_open_channel_actions/i.test(read(f)));
    expect(later, "a later migration redefines the view: rebuild from IT").toEqual([]);
  });
});
