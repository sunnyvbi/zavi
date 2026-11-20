
begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.agent_runs'::regclass and c.contype in ('u', 'p')
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['id', 'tenant_id']
  ) then
    alter table public.agent_runs add constraint agent_runs_id_tenant_uq unique (id, tenant_id);
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.decisions'::regclass and c.contype in ('u', 'p')
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['id', 'tenant_id']
  ) then
    alter table public.decisions add constraint decisions_tenant_id_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.channel_actions'::regclass and c.contype in ('u', 'p')
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['id', 'tenant_id']
  ) then
    alter table public.channel_actions add constraint channel_actions_tenant_id_id_key unique (tenant_id, id);
  end if;
end $$;

alter table public.agent_runs add column if not exists source_decision_id uuid;
alter table public.agent_runs
  add constraint agent_runs_source_decision_fk
  foreign key (tenant_id, source_decision_id) references public.decisions (tenant_id, id);

create or replace function public._agent_run_source_decision()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v text := new.payload ->> 'source_decision_id';
begin
  if new.source_decision_id is null
     and v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and exists (
       select 1 from decisions
        where id = v::uuid and tenant_id = new.tenant_id and decision_class = 'cgo.dispatch-specialist'
     ) then
    new.source_decision_id := v::uuid;
  end if;
  return new;
end $$;

drop trigger if exists agent_runs_source_decision on public.agent_runs;
create trigger agent_runs_source_decision
  before insert on public.agent_runs
  for each row execute function public._agent_run_source_decision();

alter table public.creator_offers
  add column if not exists agent_run_id uuid,
  add column if not exists agent_why text check (agent_why is null or char_length(btrim(agent_why)) between 1 and 1000);
alter table public.creator_offers
  add constraint creator_offers_agent_run_fk
  foreign key (agent_run_id, tenant_id) references public.agent_runs (id, tenant_id);

alter table public.creator_orders
  add column if not exists channel_action_id uuid,
  add column if not exists agent_run_id uuid;
alter table public.creator_orders
  add constraint creator_orders_channel_action_fk
  foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);
alter table public.creator_orders
  add constraint creator_orders_agent_run_fk
  foreign key (agent_run_id, tenant_id) references public.agent_runs (id, tenant_id);

alter table public.creator_hire_spend
  add column if not exists channel_action_id uuid,
  add column if not exists approved_by_user_id uuid;
alter table public.creator_hire_spend
  add constraint creator_hire_spend_channel_action_fk
  foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);

alter table public.ad_budget_reservations
  add column if not exists channel_action_id uuid,
  add column if not exists decision_id uuid;
alter table public.ad_budget_reservations
  add constraint ad_budget_reservations_channel_action_fk
  foreign key (tenant_id, channel_action_id) references public.channel_actions (tenant_id, id);
alter table public.ad_budget_reservations
  add constraint ad_budget_reservations_decision_fk
  foreign key (tenant_id, decision_id) references public.decisions (tenant_id, id);

drop function if exists public.reserve_ad_spend(uuid, text, text, text, text, numeric);
create or replace function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric,
  p_channel_action_id uuid default null,
  p_decision_id       uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_res      ad_budget_reservations%rowtype;
  v_today    date;
  v_delta    numeric(12,2);
  v_amt      numeric(12,2);
  v_cap      numeric(12,2);
  v_reason   text;
  v_updated  uuid;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'reserve_ad_spend: tenant and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
    raise exception 'reserve_ad_spend: invalid platform %', p_platform;
  end if;
  if p_op is null or p_op not in ('raise', 'resume', 'create') then
    raise exception 'reserve_ad_spend: invalid op %', p_op;
  end if;
  if p_daily_delta_usd is null or not (p_daily_delta_usd >= 0 and p_daily_delta_usd < 1000000) then
    raise exception 'reserve_ad_spend: invalid daily delta';
  end if;
  if p_channel_action_id is not null and not exists (
    select 1 from channel_actions where id = p_channel_action_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: channel action not found for tenant';
  end if;
  if p_decision_id is not null and not exists (
    select 1 from decisions where id = p_decision_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: decision not found for tenant';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0, 'reason', null);
  end if;

  v_today := _ad_budget_today();

  if p_op in ('raise', 'resume')
     and exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'reserved' and idem_key <> p_idem_key)
     and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and idem_key = p_idem_key
          and status in ('reserved', 'committed')) then
    return jsonb_build_object('status', 'refused', 'amount_usd', 0, 'reason', 'object_busy');
  end if;

  v_delta := ceil(p_daily_delta_usd * 100) / 100;
  if p_op in ('raise', 'resume') then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
         and not pause_due
    ), 0), 0);
  end if;
  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  v_cap := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt)
  on conflict (budget_id, idem_key) do nothing
  returning * into v_res;

  if not found then
    select * into v_res from ad_budget_reservations
     where budget_id = v_budget.id and idem_key = p_idem_key
     for update;
    if v_res.status in ('reserved', 'committed') then
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_res.amount_usd, 'reason', null,
        'month_cap_usd', v_cap);
    end if;
    update ad_budget_reservations
       set daily_delta_usd = v_delta, amount_usd = v_amt, released_on = null, pause_due = false,
           object_id = coalesce(p_object_id, object_id),
           status = 'reserved', reason = null, updated_at = now()
     where id = v_res.id
     returning * into v_res;
  end if;

  if p_channel_action_id is not null or p_decision_id is not null then
    update ad_budget_reservations
       set channel_action_id = coalesce(channel_action_id, p_channel_action_id),
           decision_id = coalesce(decision_id, p_decision_id)
     where id = v_res.id;
  end if;

  if v_delta = 0 then
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  update ad_budgets
     set updated_at = now()
   where id = v_budget.id
     and status = 'active'
     and _ad_budget_spent_usd(spent_usd, month_start, v_today)
         + _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id)
         + _creator_hire_used_usd(v_budget.id, v_today)
         + v_amt <= v_cap
     and (daily_limit_usd is null or coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta <= daily_limit_usd)
  returning id into v_updated;
  if v_updated is not null then
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  v_reason := case
    when v_budget.daily_limit_usd is not null and coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta > v_budget.daily_limit_usd
      then 'over_daily_limit'
    else 'over_month'
  end;
  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

drop function if exists public.reserve_creator_hire(uuid, text, uuid, numeric, uuid);
create or replace function public.reserve_creator_hire(
  p_tenant_id  uuid,
  p_idem_key   text,
  p_order_id   uuid,
  p_amount_usd numeric,
  p_caps_id    uuid,
  p_channel_action_id   uuid default null,
  p_approved_by_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_caps   cgo_creator_caps%rowtype;
  v_row    creator_hire_spend%rowtype;
  v_today  date;
  v_amt    numeric(12,2);
  v_week   numeric(12,2);
  v_left   numeric(12,2);
begin
  if p_tenant_id is null or p_order_id is null or p_idem_key is null
     or char_length(btrim(p_idem_key)) not between 1 and 200 then
    raise exception 'reserve_creator_hire: tenant, order and idem_key are required';
  end if;
  if p_amount_usd is null or not (p_amount_usd > 0 and p_amount_usd < 1000000) then
    raise exception 'reserve_creator_hire: invalid amount';
  end if;
  v_amt := ceil(p_amount_usd * 100) / 100;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0);
  end if;

  if not exists (select 1 from creator_orders where id = p_order_id and tenant_id = p_tenant_id) then
    raise exception 'reserve_creator_hire: order not found for tenant';
  end if;
  if p_channel_action_id is not null and not exists (
    select 1 from channel_actions where id = p_channel_action_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_creator_hire: channel action not found for tenant';
  end if;
  if p_approved_by_user_id is not null and not exists (
    select 1 from tenant_users where user_id = p_approved_by_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_creator_hire: approver is not a member of the tenant';
  end if;

  v_today := _ad_budget_today();

  select * into v_row from creator_hire_spend
   where budget_id = v_budget.id and idem_key = p_idem_key
   for update;
  if found then
    if v_row.order_id <> p_order_id then
      raise exception 'reserve_creator_hire: idem_key belongs to another order';
    end if;
    if v_row.state in ('held', 'spent', 'refunded') then
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_row.amount_usd, 'state', v_row.state);
    end if;
  end if;
  if exists (
    select 1 from creator_hire_spend
     where order_id = p_order_id and state in ('held', 'spent', 'refunded') and idem_key <> p_idem_key
  ) then
    raise exception 'reserve_creator_hire: the order already has a live reservation';
  end if;

  select * into v_caps from cgo_creator_caps
   where id = p_caps_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('status', 'no_caps', 'amount_usd', v_amt);
  end if;

  if v_amt > v_caps.per_hire_usd then
    return jsonb_build_object('status', 'over_hire_cap', 'amount_usd', v_amt, 'per_hire_usd', v_caps.per_hire_usd);
  end if;

  select coalesce(sum(case when s.state = 'held' then s.amount_usd else s.amount_usd - s.refunded_usd end), 0)
    into v_week
    from creator_hire_spend s
   where s.tenant_id = p_tenant_id
     and s.state in ('held', 'spent')
     and s.reserved_on > v_today - 7;
  if v_week + v_amt > v_caps.per_week_usd then
    return jsonb_build_object('status', 'over_week_cap', 'amount_usd', v_amt,
      'per_week_usd', v_caps.per_week_usd, 'week_used_usd', v_week);
  end if;

  v_left := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today)
          - _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)
          - _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin)
          - _creator_hire_used_usd(v_budget.id, v_today);
  if v_amt > v_left then
    return jsonb_build_object('status', 'over_budget', 'amount_usd', v_amt, 'left_usd', greatest(v_left, 0));
  end if;

  if v_row.id is null then
    insert into creator_hire_spend
      (tenant_id, budget_id, caps_id, idem_key, order_id, amount_usd, state, reserved_on)
    values
      (p_tenant_id, v_budget.id, v_caps.id, p_idem_key, p_order_id, v_amt, 'held', v_today);
  else
    update creator_hire_spend
       set caps_id = v_caps.id, amount_usd = v_amt, refunded_usd = 0, state = 'held',
           reserved_on = v_today, settled_at = null
     where id = v_row.id;
  end if;

  if p_channel_action_id is not null or p_approved_by_user_id is not null then
    update creator_hire_spend
       set channel_action_id = coalesce(channel_action_id, p_channel_action_id),
           approved_by_user_id = coalesce(approved_by_user_id, p_approved_by_user_id)
     where budget_id = v_budget.id and idem_key = p_idem_key;
  end if;

  return jsonb_build_object('status', 'reserved', 'amount_usd', v_amt, 'left_usd', v_left - v_amt);
end $$;

create table if not exists public.autopilot_goal_changes (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  goal_id            uuid not null,
  op                 text not null check (op in ('insert', 'update', 'delete')),
  changed_fields     jsonb not null check (jsonb_typeof(changed_fields) = 'object'),
  changed_by_source  text not null check (changed_by_source in ('cgo', 'founder', 'staff', 'system')),
  changed_by_user_id uuid,
  run_id             uuid,
  why                text check (why is null or char_length(why) between 1 and 1000),
  created_at         timestamptz not null default now(),
  check (changed_by_source <> 'cgo' or (run_id is not null and why is not null)),
  check (changed_by_source not in ('founder', 'staff') or changed_by_user_id is not null)
);

create index if not exists autopilot_goal_changes_tenant_created_idx
  on public.autopilot_goal_changes (tenant_id, created_at desc);

alter table public.autopilot_goal_changes enable row level security;

create policy autopilot_goal_changes_member_select on public.autopilot_goal_changes
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = autopilot_goal_changes.tenant_id
    )
  );
create policy autopilot_goal_changes_active_tenant_restrict
  on public.autopilot_goal_changes as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.autopilot_goal_changes from public, anon;
revoke insert, update, delete, truncate on public.autopilot_goal_changes from authenticated;
grant select on public.autopilot_goal_changes to authenticated;
revoke all on public.autopilot_goal_changes from service_role;
grant select on public.autopilot_goal_changes to service_role;

create or replace function public._autopilot_goal_history()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_skip   constant text[] := array['id', 'tenant_id', 'created_at', 'updated_at',
                                    'current_value', 'current_value_at', 'current_value_source',
                                    'cgo_status_line', 'cgo_status_at', 'cgo_undo', 'status_changed_at'];
  v_old    jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new    jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row    jsonb := coalesce(v_new, v_old);
  v_tenant uuid := (v_row ->> 'tenant_id')::uuid;
  v_fields jsonb := '{}'::jsonb;
  v_from   jsonb;
  v_to     jsonb;
  v_src    text := nullif(current_setting('zavi.goal_actor', true), '');
  v_user   uuid;
  v_run    uuid;
  v_why    text;
  k        text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from tenants where id = v_tenant) then
    return null;
  end if;
  for k in select jsonb_object_keys(v_row) loop
    continue when k = any (v_skip);
    v_from := coalesce(v_old -> k, 'null'::jsonb);
    v_to   := coalesce(v_new -> k, 'null'::jsonb);
    if v_from is distinct from v_to then
      v_fields := v_fields || jsonb_build_object(k, jsonb_build_object('from', v_from, 'to', v_to));
    end if;
  end loop;
  if v_fields = '{}'::jsonb then
    return null;
  end if;

  if v_src is null then
    v_user := auth.uid();
    v_src := case when v_user is null then 'system' else 'founder' end;
  else
    v_user := nullif(current_setting('zavi.goal_user', true), '')::uuid;
    v_run  := nullif(current_setting('zavi.goal_run', true), '')::uuid;
    v_why  := nullif(current_setting('zavi.goal_why', true), '');
  end if;

  insert into autopilot_goal_changes
    (tenant_id, goal_id, op, changed_fields, changed_by_source, changed_by_user_id, run_id, why)
  values
    (v_tenant, (v_row ->> 'id')::uuid, lower(tg_op), v_fields, v_src, v_user, v_run, v_why);
  return null;
end $$;

drop trigger if exists autopilot_goals_history on public.autopilot_goals;
create trigger autopilot_goals_history
  after insert or update or delete on public.autopilot_goals
  for each row execute function public._autopilot_goal_history();

create or replace function public.write_autopilot_goal(
  p_tenant_id     uuid,
  p_op            text,
  p_goal_id       uuid,
  p_values        jsonb,
  p_expect        jsonb,
  p_status_not_in text[],
  p_actor_source  text,
  p_actor_user_id uuid,
  p_run_id        uuid,
  p_why           text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_why    text := left(nullif(btrim(coalesce(p_why, '')), ''), 1000);
  v_expect jsonb := coalesce(p_expect, '{}'::jsonb);
  v_bad    text;
  v_set    text;
  v_cols   text;
  v_rcols  text;
  v_where  text;
  v_id     uuid;
begin
  if p_tenant_id is null then
    raise exception 'write_autopilot_goal: tenant is required';
  end if;
  if p_op is null or p_op not in ('insert', 'update', 'delete') then
    raise exception 'write_autopilot_goal: invalid op %', p_op;
  end if;
  if p_actor_source is null or p_actor_source not in ('cgo', 'founder', 'staff', 'system') then
    raise exception 'write_autopilot_goal: invalid actor %', p_actor_source;
  end if;
  if p_actor_source = 'cgo' and (p_run_id is null or v_why is null) then
    raise exception 'write_autopilot_goal: a cgo write needs its run and why';
  end if;
  if p_actor_source in ('founder', 'staff') and p_actor_user_id is null then
    raise exception 'write_autopilot_goal: a % write needs the user', p_actor_source;
  end if;
  if p_actor_source not in ('founder', 'staff') and p_actor_user_id is not null then
    raise exception 'write_autopilot_goal: only a founder or staff write names a user';
  end if;
  if p_actor_source = 'founder' and not exists (
    select 1 from tenant_users where user_id = p_actor_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'write_autopilot_goal: user is not a member of the tenant';
  end if;
  if p_actor_source = 'staff' and not exists (
    select 1 from staff_users where user_id = p_actor_user_id and revoked_at is null
  ) then
    raise exception 'write_autopilot_goal: user is not active staff';
  end if;
  if p_run_id is not null and not exists (
    select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id
  ) then
    raise exception 'write_autopilot_goal: run not found for tenant';
  end if;
  if (p_op = 'insert') <> (p_goal_id is null) then
    raise exception 'write_autopilot_goal: an insert takes no goal id, an update or delete needs one';
  end if;
  if p_op <> 'delete' and (p_values is null or jsonb_typeof(p_values) <> 'object' or p_values = '{}'::jsonb) then
    raise exception 'write_autopilot_goal: values are required';
  end if;
  if p_op = 'delete' and p_values is not null and p_values <> '{}'::jsonb then
    raise exception 'write_autopilot_goal: a delete takes no values';
  end if;
  if jsonb_typeof(v_expect) <> 'object' then
    raise exception 'write_autopilot_goal: expect must be an object';
  end if;

  select k into v_bad
    from (select jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) as k
          union select jsonb_object_keys(v_expect)) s
   where k in ('id', 'tenant_id', 'created_at')
      or not exists (
        select 1 from pg_attribute a
         where a.attrelid = 'public.autopilot_goals'::regclass and a.attname = s.k
           and a.attnum > 0 and not a.attisdropped and a.attgenerated = '')
   limit 1;
  if v_bad is not null then
    raise exception 'write_autopilot_goal: column % cannot be written or matched', v_bad;
  end if;

  select string_agg(format('%1$I = r.%1$I', k), ', ' order by k),
         string_agg(format('%I', k), ', ' order by k),
         string_agg(format('r.%I', k), ', ' order by k)
    into v_set, v_cols, v_rcols
    from jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) k;
  select coalesce(string_agg(format(' and g.%1$I is not distinct from e.%1$I', k), '' order by k), '')
    into v_where
    from jsonb_object_keys(v_expect) k;

  perform set_config('zavi.goal_actor', p_actor_source, true);
  perform set_config('zavi.goal_user', coalesce(p_actor_user_id::text, ''), true);
  perform set_config('zavi.goal_run', coalesce(p_run_id::text, ''), true);
  perform set_config('zavi.goal_why', coalesce(v_why, ''), true);

  if p_op = 'insert' then
    execute format(
      'insert into autopilot_goals (tenant_id, %s) select $4, %s
         from jsonb_populate_record(null::autopilot_goals, $1) r returning id', v_cols, v_rcols)
      into v_id using p_values, v_expect, p_goal_id, p_tenant_id, p_status_not_in;
  elsif p_op = 'update' then
    execute format(
      'update autopilot_goals g set %s
         from jsonb_populate_record(null::autopilot_goals, $1) r,
              jsonb_populate_record(null::autopilot_goals, $2) e
        where g.id = $3 and g.tenant_id = $4%s
          and ($5 is null or not (g.status = any ($5)))
        returning g.id', v_set, v_where)
      into v_id using p_values, v_expect, p_goal_id, p_tenant_id, p_status_not_in;
  else
    execute format(
      'delete from autopilot_goals g
        using jsonb_populate_record(null::autopilot_goals, $2) e
        where g.id = $3 and g.tenant_id = $4%s
          and ($5 is null or not (g.status = any ($5)))
        returning g.id', v_where)
      into v_id using p_values, v_expect, p_goal_id, p_tenant_id, p_status_not_in;
  end if;

  perform set_config('zavi.goal_actor', '', true);
  perform set_config('zavi.goal_user', '', true);
  perform set_config('zavi.goal_run', '', true);
  perform set_config('zavi.goal_why', '', true);

  return jsonb_build_object('status', case when v_id is null then 'not_matched' else 'written' end, 'id', v_id);
end $$;

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid) from public, anon, authenticated;
revoke all on function public.reserve_creator_hire(uuid, text, uuid, numeric, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.write_autopilot_goal(uuid, text, uuid, jsonb, jsonb, text[], text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public._autopilot_goal_history() from public, anon, authenticated;
revoke all on function public._agent_run_source_decision() from public, anon, authenticated;

grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid) to service_role;
grant execute on function public.reserve_creator_hire(uuid, text, uuid, numeric, uuid, uuid, uuid) to service_role;
grant execute on function public.write_autopilot_goal(uuid, text, uuid, jsonb, jsonb, text[], text, uuid, uuid, text) to service_role;

commit;
