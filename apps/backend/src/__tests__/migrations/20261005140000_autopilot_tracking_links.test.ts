import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261005140000_autopilot_tracking_links.sql";
const PRIOR = "20261005090000_creator_hire_budget.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const prior = readFileSync(join(MIG_DIR, PRIOR), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const fnIn = (text: string, name: string) => {
  const at = text.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return text.slice(at, text.indexOf("end $$;", at));
};
const code = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--"));

describe("20261005140000_autopilot_tracking_links", () => {
  it("sorts after every earlier migration", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(FILE);
    expect(FILE > "20261005130000_request_idempotency.sql").toBe(true);
  });

  it("the rebuilt functions' latest prior definition is 20261005090000, and nothing later redefines them", () => {
    const REBUILT_LATER: Record<string, string[]> = {
      "20261012110000_cgo_spend_pace_holds.sql": ["reserve_ad_spend"],
      "20261022140000_ad_budget_raise_holds_increase.sql": ["reserve_ad_spend"],
      "20261023125328_chatgpt_growth_autopilot.sql": ["reserve_ad_spend"],
      "20261107110000_ad_holds_bounded_by_object.sql": ["reserve_ad_spend"],
    };
    const others = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > PRIOR && f !== FILE);
    for (const f of others) {
      const t = readFileSync(join(MIG_DIR, f), "utf8");
      for (const name of ["reserve_ad_spend", "reserve_creator_hire", "write_autopilot_goal", "_autopilot_goal_history"]) {
        if (REBUILT_LATER[f]?.includes(name)) continue;
        expect(t, `${f} redefines ${name}`).not.toContain(`function public.${name}(`);
      }
    }
  });

  for (const [name, lastParam, links] of [
    ["reserve_ad_spend", "  p_daily_delta_usd numeric", ["p_channel_action_id", "p_decision_id"]],
    ["reserve_creator_hire", "  p_caps_id    uuid", ["p_channel_action_id", "p_approved_by_user_id"]],
  ] as const) {
    it(`${name} is a strict superset of its ${PRIOR} body, plus tenant-checked optional links kept on retry`, () => {
      const before = fnIn(prior, name);
      const after = fnIn(sql, name);
      const afterLines = new Set(after.split("\n"));
      const lost = code(before).filter((l) => !afterLines.has(l));
      expect(lost).toEqual([lastParam]);
      expect(after).toContain(`${lastParam},\n`);
      for (const p of links) {
        expect(after).toMatch(new RegExp(`\\n  ${p}\\s+uuid default null`));
        const col = p.replace(/^p_/, "");
        expect(after).toContain(`${col} = coalesce(${col}, ${p})`);
      }
      expect(after).toMatch(/select 1 from channel_actions where id = p_channel_action_id and tenant_id = p_tenant_id/);
      expect(after).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toMatch(new RegExp(`drop function if exists public\\.${name}\\(`));
    });
  }

  it("reserve_ad_spend writes the links before any return that follows the row write", () => {
    const fn = fnIn(sql, "reserve_ad_spend");
    const write = fn.indexOf("on conflict (budget_id, idem_key) do nothing");
    const link = fn.indexOf("set channel_action_id = coalesce(channel_action_id, p_channel_action_id)");
    const zero = fn.indexOf("if v_delta = 0 then");
    expect(write).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(write);
    expect(zero).toBeGreaterThan(link);
    expect(fn).toContain("select 1 from decisions where id = p_decision_id and tenant_id = p_tenant_id");
  });

  it("a run takes source_decision_id from its payload in the same insert, only for its own tenant's decision, never blocking", () => {
    expect(sql).toContain(
      "create trigger agent_runs_source_decision\n  before insert on public.agent_runs\n  for each row execute function public._agent_run_source_decision();",
    );
    const fn = fnIn(sql, "_agent_run_source_decision");
    expect(fn).toContain("security definer set search_path = public, pg_temp");
    expect(fn).toContain("where id = v::uuid and tenant_id = new.tenant_id and decision_class = 'cgo.dispatch-specialist'");
    expect(fn).not.toMatch(/raise/);
    expect(sql).toContain("revoke all on function public._agent_run_source_decision() from public, anon, authenticated;");
  });

  it("reserve_creator_hire checks the approver is a member", () => {
    expect(fnIn(sql, "reserve_creator_hire")).toContain(
      "select 1 from tenant_users where user_id = p_approved_by_user_id and tenant_id = p_tenant_id",
    );
  });

  it("every link is a composite tenant-checked FK with the default NO ACTION; no existing cascade is touched", () => {
    const fks = [
      ["agent_runs_source_decision_fk", "foreign key (tenant_id, source_decision_id) references public.decisions (tenant_id, id);"],
      ["creator_offers_agent_run_fk", "foreign key (agent_run_id, tenant_id) references public.agent_runs (id, tenant_id);"],
      ["creator_orders_channel_action_fk", "foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);"],
      ["creator_orders_agent_run_fk", "foreign key (agent_run_id, tenant_id) references public.agent_runs (id, tenant_id);"],
      ["creator_hire_spend_channel_action_fk", "foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);"],
      ["ad_budget_reservations_channel_action_fk", "foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);"],
      ["ad_budget_reservations_decision_fk", "foreign key (tenant_id, decision_id) references public.decisions (tenant_id, id);"],
    ];
    for (const [name, def] of fks) expect(sql).toContain(`add constraint ${name}\n  ${def}`);
    expect(sql).not.toMatch(/on delete (cascade|restrict|set null)[^;]*references public\.(decisions|agent_runs|channel_actions)/);
    expect(sql).not.toMatch(/references public\.(decisions|agent_runs|channel_actions) \([^)]*\) on delete/);
    expect(sql).not.toMatch(/drop constraint/);
    expect(sql).toContain("alter table public.decisions add constraint decisions_tenant_id_id_key unique (tenant_id, id);");
  });

  it("autopilot_goal_changes: RLS on, member + active-tenant select only, no client writes, the service role only reads", () => {
    expect(sql).toContain("alter table public.autopilot_goal_changes enable row level security;");
    expect(sql).toContain("create policy autopilot_goal_changes_member_select on public.autopilot_goal_changes\n  for select using (");
    expect(sql).toMatch(
      /create policy autopilot_goal_changes_active_tenant_restrict\s+on public\.autopilot_goal_changes as restrictive for select\s+using \(tenant_id = \(select public\.app_active_tenant\(\)\)\);/,
    );
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    expect(sql).toContain("revoke insert, update, delete, truncate on public.autopilot_goal_changes from authenticated;");
    expect(sql).toContain("revoke all on public.autopilot_goal_changes from service_role;");
    expect(sql).toContain("grant select on public.autopilot_goal_changes to service_role;");
    expect(sql).toContain("check (op in ('insert', 'update', 'delete'))");
    expect(sql).toContain("check (changed_by_source in ('cgo', 'founder', 'staff', 'system'))");
    expect(sql).toContain("check (changed_by_source not in ('founder', 'staff') or changed_by_user_id is not null)");
    expect(sql).toContain("check (changed_by_source <> 'cgo' or (run_id is not null and why is not null))");
    expect(registry).toMatch(/\n\s*autopilot_goal_changes: "tenant_id",/);
  });

  it("the history trigger fires after insert, update and delete, and reads who/why from transaction-local settings", () => {
    expect(sql).toContain(
      "create trigger autopilot_goals_history\n  after insert or update or delete on public.autopilot_goals\n  for each row execute function public._autopilot_goal_history();",
    );
    const fn = fnIn(sql, "_autopilot_goal_history");
    expect(fn).toContain("security definer set search_path = public, pg_temp");
    for (const k of ["zavi.goal_actor", "zavi.goal_user", "zavi.goal_run", "zavi.goal_why"]) {
      expect(fn).toContain(`current_setting('${k}', true)`);
    }
    expect(fn).toContain("if tg_op = 'DELETE' and not exists (select 1 from tenants where id = v_tenant) then");
  });

  it("write_autopilot_goal: security definer, cgo needs run + why, settings local to the transaction, service-role only, registered", () => {
    const fn = fnIn(sql, "write_autopilot_goal");
    expect(fn).toContain("security definer set search_path = public, pg_temp");
    expect(fn).toContain("if p_actor_source = 'cgo' and (p_run_id is null or v_why is null) then");
    expect(fn).toContain("select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id");
    expect(fn).toContain("select 1 from tenant_users where user_id = p_actor_user_id and tenant_id = p_tenant_id");
    expect(fn).toContain("select 1 from staff_users where user_id = p_actor_user_id and revoked_at is null");
    expect(fn).toContain("where g.id = $3 and g.tenant_id = $4%s");
    expect(fn).toContain("where k in ('id', 'tenant_id', 'created_at')");
    for (const k of ["zavi.goal_actor", "zavi.goal_user", "zavi.goal_run", "zavi.goal_why"]) {
      expect(fn).toMatch(new RegExp(`set_config\\('${k.replace(".", "\\.")}', [^;]*, true\\)`));
      expect(fn).toContain(`perform set_config('${k}', '', true);`);
    }
    expect(fn).not.toMatch(/set_config\([^)]*false\)/);
    const sig = "uuid, text, uuid, jsonb, jsonb, text[], text, uuid, uuid, text";
    expect(sql).toContain(`revoke all on function public.write_autopilot_goal(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.write_autopilot_goal(${sig}) to service_role;`);
    expect(registry).toMatch(/\n\s*write_autopilot_goal: "p_tenant_id",/);
  });

  it("the rebuilt reserves keep their grants on the new signatures, and nothing is granted to clients", () => {
    for (const s of [
      "reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid)",
      "reserve_creator_hire(uuid, text, uuid, numeric, uuid, uuid, uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${s} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${s} to service_role;`);
    }
    expect(sql).toContain("revoke all on function public._autopilot_goal_history() from public, anon, authenticated;");
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*autopilot_goal_changes/);
  });
});
