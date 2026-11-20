import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf-8");

const FILE = "20261009100200_channel_card_layered_dedupe.sql";
const NEW = read(FILE);
const PRIOR_EXEC = read("20261003090000_channel_exec_action_replaces_older.sql");
const PRIOR_PROSE = read("20261001200000_channel_action_retire_guard.sql");

function fn(sql: string, name: string): string {
  const i = sql.indexOf(`create or replace function ${name}(`);
  expect(i, `${name} defined`).toBeGreaterThanOrEqual(0);
  const j = sql.indexOf("end $$;", i);
  return sql.slice(i, j + "end $$;".length);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function cut(s: string, from: string, to: string): string {
  const a = s.indexOf(from);
  expect(a, `marker: ${from.slice(0, 50)}`).toBeGreaterThanOrEqual(0);
  const b = s.indexOf(to, a + from.length);
  expect(b, `marker: ${to.slice(0, 50)}`).toBeGreaterThan(a);
  return s.slice(0, a) + s.slice(b);
}

function drop(s: string, exact: string): string {
  expect(s.includes(exact), `literal: ${exact.slice(0, 60)}`).toBe(true);
  return s.replace(exact, "");
}

const LOCK = "pg_advisory_xact_lock(hashtextextended('channel_card:' || v_tenant || ':' || v_channel, 0))";
const GUARD_PRIOR = [
  "and (status = 'pending' or snoozed_until is null or snoozed_until <= now())",
  "and (exec_status is null",
  "or (exec_status = 'failed'",
  "and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')",
  "and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')",
  "and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))",
  "and edited_body is null",
  "and steps_done = '[]'::jsonb",
];

describe(FILE, () => {
  it("is the definition of both writers right before 20261020160000, rebuilt from their latest prior files", () => {
    const defs = (name: string) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .filter((f) => new RegExp(`function (public\\.)?${name}\\s*\\(`, "i").test(read(f)))
        .sort();
    const NEXT = "20261020160000_uncertain_failed_twin_stays_open.sql";
    expect(defs("record_channel_exec_action").slice(-4)).toEqual(["20261003090000_channel_exec_action_replaces_older.sql", FILE, NEXT, "20261110220000_founder_order_authority.sql"]);
    expect(defs("record_channel_run_actions").slice(-4)).toEqual(["20261001200000_channel_action_retire_guard.sql", FILE, NEXT, "20261111090000_untargeted_card_layer1_dedupe.sql"]);
  });

  it("schema: target_key with its length check and the two partial indexes", () => {
    expect(NEW).toContain(
      "alter table channel_actions add column if not exists target_key text check (target_key is null or char_length(target_key) <= 300);",
    );
    expect(NEW).toContain(
      "create index if not exists channel_actions_open_target_idx on channel_actions (tenant_id, channel_slug, target_key) where status in ('pending', 'snoozed') and target_key is not null;",
    );
    expect(NEW).toContain(
      "create index if not exists channel_actions_open_by_channel_idx on channel_actions (tenant_id, channel_slug, proposed_at desc) where status in ('pending', 'snoozed');",
    );
  });

  describe("record_channel_exec_action", () => {
    const body = fn(NEW, "record_channel_exec_action");
    const at = (s: string) => {
      const i = body.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };

    it("takes the lock after the channel is resolved and BEFORE the same-run replay", () => {
      expect(at("v_channel is null")).toBeLessThan(at(LOCK));
      expect(at(LOCK)).toBeLessThan(at("'replayed', true"));
    });

    it("snapshot re-match: reads judged_ids, checks open same-target cards outside it, answers rematch before any write", () => {
      expect(body).toContain("jsonb_array_elements_text(p_action->'judged_ids')");
      expect(body).toContain("and target_key = v_target");
      expect(body).toContain("and not (id = any(v_judged))");
      expect(at("'code', 'rematch'")).toBeLessThan(at("update channel_actions"));
      expect(at("'code', 'rematch'")).toBeLessThan(at("insert into channel_actions"));
      expect(at("'replayed', true")).toBeLessThan(at("'code', 'rematch'"));
    });

    it("repeat target: locked for update; closed -> rematch; touched -> kept; all before the insert", () => {
      const rep = body.slice(at("where id = v_want"), at("'reason', 'repeat_closed'"));
      expect(rep).toMatch(/and tenant_id = v_tenant\s+and channel_slug = v_channel\s+for update;/);
      expect(at("'reason', 'repeat_closed'")).toBeLessThan(at("'kept', true"));
      expect(body.lastIndexOf("'kept', true")).toBeLessThan(at("insert into channel_actions"));
    });

    it("Layer 1 before the insert: family + object, or identical payload that is more than a name; never a name alone", () => {
      const l1 = body.slice(at("for v_old, v_untouched in"), at("end loop;"));
      expect(l1).toContain("regexp_replace(exec_class, '_review$', '') = v_family");
      expect(l1).toContain("(v_norm - 'name' - 'campaign_name') <> '{}'::jsonb");
      expect(l1).toContain("(exec_payload - 'rationale' - 'decision_evidence' - 'about') = v_norm");
      expect(l1).toMatch(/for update\s*$/m);
      expect(body).not.toMatch(/exec_payload->>'name'\s*=/);
      expect(at("for v_old, v_untouched in")).toBeLessThan(at("insert into channel_actions"));
      const ins = at("insert into channel_actions");
      expect(body.slice(ins)).not.toContain("set status = 'stale'");
    });

    it("the money guard is 20261003090000's, verbatim, plus the partial-risk verdict line, in every retire path", () => {
      const prior = fn(PRIOR_EXEC, "record_channel_exec_action");
      for (const line of GUARD_PRIOR) expect(norm(prior)).toContain(norm(line));
      const retire = body.slice(at("with retired as ("), at("returning id, proposed_at"));
      for (const line of [...GUARD_PRIOR, "and coalesce(exec_result->>'bucket', '') <> 'partial_risk'"]) {
        expect(norm(retire)).toContain(norm(line));
      }
      expect(body.match(/coalesce\(exec_result->>'bucket', ''\) <> 'partial_risk'/g)?.length).toBe(3);
    });

    it("is the prior body plus the Part C blocks, with the post-insert replace block moved, not changed", () => {
      const prior = fn(PRIOR_EXEC, "record_channel_exec_action")
        .replace(/\n +v_obj +text;\n +v_subject text;\n +v_old +uuid;\n +v_replaced int := 0;/, "")
        .replace(/\n+ *-- A newer version of the same change[\s\S]*?\n {4}end loop;\n {2}end if;\n/, "\n")
        .replace(/,\n +'replaced', v_replaced\);/, ");");
      let b = body;
      b = cut(b, "\n  v_obj     text;", "\nbegin\n");
      b = cut(b, "\n  -- One card writer per (tenant, channel)", "\n\n  -- Same change, same run");
      b = cut(b, "\n\n  -- What this card is:", "\n\n  -- Reserved band");
      b = drop(b, ", repeat_of, target_key");
      b = drop(b, ", v_repeat, v_target");
      b = cut(b, "\n\n  foreach v_old in array v_retired", "\n\n  insert into channel_action_events\n    (tenant_id, action_id, event, actor_kind, run_id, event_key)");
      b = drop(b, ",\n                            'replaced', v_replaced, 'repeat_of', v_repeat");
      expect(norm(b)).toBe(norm(prior));
    });
  });

  describe("record_channel_run_actions", () => {
    const body = fn(NEW, "record_channel_run_actions");
    const at = (s: string) => {
      const i = body.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };

    it("takes the same lock after the channel is resolved, before the snapshot, the metrics and the stale step", () => {
      expect(at("v_channel is null")).toBeLessThan(at(LOCK));
      expect(at(LOCK)).toBeLessThan(at("-- 0. Snapshot re-match"));
      expect(at("return jsonb_build_object('rematch', true, 'positions', v_rematch)")).toBeLessThan(at("insert into channel_metrics"));
      expect(at("return jsonb_build_object('rematch', true, 'positions', v_rematch)")).toBeLessThan(at("-- 3. Stale flags"));
    });

    it("snapshot: per action judged_ids, same-target open cards of OTHER runs, and a closed matcher repeat target", () => {
      const snap = body.slice(at("-- 0. Snapshot re-match"), at("-- 1. Metrics"));
      expect(snap).toContain("jsonb_array_elements_text(v_a->'judged_ids')");
      expect(snap).toContain("and target_key = v_tkey");
      expect(snap).toContain("and run_id <> p_run_id");
      expect(snap).toContain("and not (id = any(v_judged))");
      expect(snap).toContain("v_a->'repeat_matched' = 'true'::jsonb");
      expect(snap).toMatch(/where id = v_want and tenant_id = v_tenant and channel_slug = v_channel\s+for update;/);
      expect(snap).not.toMatch(/insert into|update channel_actions/);
    });

    it("Layer 1 per action: target, type and title on a manual card of another run, locked; touched -> kept; skipped for a replay and a redo", () => {
      const l1 = body.slice(at("-- Layered dedupe (Part C)."), at("-- The card's words, decided by the writer"));
      expect(l1).toContain("target_key = v_tkey and action_type = v_type and title_key = v_title_key");
      expect(l1).toContain("and exec_class is null");
      expect(l1).toContain("and run_id <> p_run_id");
      expect(l1).toContain("not exists (select 1 from channel_actions where run_id = p_run_id and tenant_id = v_tenant and position = v_pos)");
      expect(l1).toContain("v_redo is null");
      expect(l1).toContain("jsonb_build_object('position', v_pos, 'id', v_kept, 'kept', true)");
      expect((l1.match(/for update/g) ?? []).length).toBe(2);
      expect(at("-- Layered dedupe (Part C).")).toBeLessThan(body.lastIndexOf("insert into channel_actions"));
    });

    it("is the prior body plus exactly the Part C blocks (every prior statement kept, in order)", () => {
      const prior = fn(PRIOR_PROSE, "record_channel_run_actions");
      let b = body;
      b = cut(b, "\n  v_tkey      text;", "\nbegin\n");
      b = cut(b, "\n  -- One card writer per (tenant, channel)", "\n\n  -- 1. Metrics");
      b = drop(b, "\n      -- Retired by this call: a card of this run may name it in repeat_of.\n      v_retired_here := v_retired_here || v_target;");
      b = cut(b, "\n\n      -- Layered dedupe (Part C).", "\n\n      -- The card's words, decided by the writer");
      b = drop(b, ", target_key");
      b = drop(b, ", v_tkey");
      b = cut(b, "\n        -- The Layer-1 cards this one replaced", "\n      end if;\n      v_ids := v_ids ||");
      b = drop(b, "\n    'replaced', v_replaced,");
      expect(norm(b)).toBe(norm(prior));
    });
  });

  describe("backfill RPCs", () => {
    it("chain_channel_action_repeat: lock first, both rows locked in id order, repeat_of only in the retiring statement", () => {
      const body = fn(NEW, "chain_channel_action_repeat");
      const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_channel, 0))");
      const rows = body.indexOf("order by id\n   for update;");
      expect(lock).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(lock);
      expect(body).toMatch(
        /with retired as \(update channel_actions set status = 'stale'[^;]*returning id\) update channel_actions set repeat_of = p_old_id where id = p_new_id and tenant_id = p_tenant_id and repeat_of is null and exists \(select 1 from retired\);/,
      );
      const retire = body.slice(body.indexOf("with retired as"), body.indexOf("returning id)"));
      for (const line of [...GUARD_PRIOR, "and coalesce(exec_result->>'bucket', '') <> 'partial_risk'"]) {
        expect(norm(retire)).toContain(norm(line));
      }
      expect((body.match(/repeat_of = p_old_id/g) ?? []).length).toBe(2);
    });

    it("stamp_channel_action_target_keys never overwrites and stays in the tenant; list_open_card_channels is keyset-paged", () => {
      const stamp = fn(NEW, "stamp_channel_action_target_keys");
      expect(stamp).toContain("and a.tenant_id = p_tenant_id");
      expect(stamp).toContain("and a.target_key is null");
      expect(stamp).toContain("jsonb_array_length(p_pairs) > 1000");
      const list = NEW.slice(NEW.indexOf("create or replace function list_open_card_channels("), NEW.indexOf("$$;", NEW.indexOf("create or replace function list_open_card_channels(")));
      expect(list).toContain("(a.tenant_id, a.channel_slug) > (p_after_tenant, coalesce(p_after_channel, ''))");
      expect(list).toContain("order by a.tenant_id, a.channel_slug");
      expect(list).toContain("limit least(greatest(coalesce(p_limit, 100), 1), 500)");
    });
  });

  it("every function: signature unchanged where it existed, security definer + pinned search_path, service-role only", () => {
    for (const sig of [
      "record_channel_exec_action(uuid, uuid, jsonb)",
      "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)",
      "list_open_card_channels(uuid, text, int)",
      "stamp_channel_action_target_keys(uuid, jsonb)",
      "chain_channel_action_repeat(uuid, uuid, uuid)",
    ]) {
      expect(norm(NEW)).toContain(norm(`revoke all on function ${sig} from public, anon, authenticated;`));
      expect(norm(NEW)).toContain(norm(`grant execute on function ${sig} to service_role;`));
    }
    expect(NEW.match(/security definer set search_path = public, pg_temp/g)?.length).toBe(5);
    expect(NEW).toContain("create or replace function record_channel_exec_action(\n  p_tenant_id uuid,\n  p_run_id    uuid,\n  p_action    jsonb\n) returns jsonb");
    expect(NEW).toContain(
      "create or replace function record_channel_run_actions(\n  p_tenant_id uuid,\n  p_run_id    uuid,\n  p_actions   jsonb,\n  p_metrics   jsonb,\n  p_stale     jsonb\n) returns jsonb",
    );
  });
});
