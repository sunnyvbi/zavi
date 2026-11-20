
begin;

alter table tenant_credit_ledger add column if not exists debited int;
comment on column tenant_credit_ledger.debited is
  'settle rows (from 20260924130200): credits actually taken from the tenant. amount - debited = overrun absorbed by Zavi. null on older rows.';

create or replace function finalize_run_credits(
  p_run_id          uuid,
  p_cost_usd        numeric,
  p_terminal_reason text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant     uuid;
  v_held       int;
  v_ps         date;
  v_attempt    int;
  v_credits    int;
  v_ia         int;
  v_iu         int;
  v_da         int;
  v_du         int;
  v_pb         int;
  v_room       int;
  v_daily_room int;
  v_from_day   int;
  v_from_inc   int;
  v_from_pur   int;
  v_rem        int;
  v_inserted   int;
begin
  select r.tenant_id, r.amount, r.period_start, r.attempt
    into v_tenant, v_held, v_ps, v_attempt
  from tenant_credit_ledger r
  where r.run_id = p_run_id and r.kind = 'reserve'
    and not exists (
      select 1 from tenant_credit_ledger t
      where t.run_id = p_run_id and t.kind in ('settle','refund') and t.attempt = r.attempt
    )
  order by r.attempt asc
  limit 1;
  if v_tenant is null then
    return 'noop';
  end if;

  perform 1 from tenant_credit_balances where tenant_id = v_tenant for update;

  if p_cost_usd is null or p_cost_usd <= 0 then
    insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start, attempt)
    values (v_tenant, p_run_id, 'refund', v_held, null, v_ps, v_attempt)
    on conflict (run_id, attempt) where kind in ('settle','refund') do nothing
    returning 1 into v_inserted;
    if v_inserted is null then
      return 'noop';
    end if;
    update tenant_credit_balances
       set reserved = greatest(reserved - v_held, 0), updated_at = now()
     where tenant_id = v_tenant;
    return 'refunded';
  end if;

  v_credits := ceil(p_cost_usd / 0.0025)::int;
  select included_allowance, included_used, daily_allowance, daily_used, purchased_balance
    into v_ia, v_iu, v_da, v_du, v_pb
  from tenant_credit_balances where tenant_id = v_tenant;

  v_daily_room := greatest(v_da - v_du, 0);
  v_from_day   := least(v_credits, v_daily_room);
  v_rem        := v_credits - v_from_day;
  v_room       := greatest(v_ia - v_iu, 0);
  v_from_inc   := least(v_rem, v_room);
  v_from_pur   := least(v_rem - v_from_inc, greatest(coalesce(v_pb, 0), 0));

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt, debited)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included'
               when (v_from_day + v_from_inc) = 0 then 'purchased'
               else 'mixed' end,
          null, p_cost_usd, v_ps, v_attempt, v_from_day + v_from_inc + v_from_pur)
  on conflict (run_id, attempt) where kind in ('settle','refund') do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'noop';
  end if;

  update tenant_credit_balances
     set reserved          = greatest(reserved - v_held, 0),
         daily_used        = daily_used + v_from_day,
         included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = v_tenant;

  return 'settled';
end $$;
revoke all on function finalize_run_credits(uuid, numeric, text) from public, anon, authenticated;
grant execute on function finalize_run_credits(uuid, numeric, text) to service_role;

create or replace function enqueue_agent_run(
  p_tenant_id uuid,
  p_agent_slug text,
  p_agent_hash text,
  p_trigger text,
  p_payload jsonb,
  p_cron_dedupe_key text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_id  uuid;
  v_enforce boolean;
  v_status  text;
  v_gf      boolean;
  v_plan    text;
  v_allow   int;
  v_iu      int;
  v_ia      int;
  v_pb      int;
  v_source  text;
begin
  if auth.uid() is not null and not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  if auth.uid() is not null and p_cron_dedupe_key like 'cgo:draft:%:setup%' then
    raise exception 'reserved dedupe key' using errcode = '42501';
  end if;

  if p_trigger = 'manual' then
    if auth.uid() is null then
      raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not exists (
      select 1 from tenant_users
      where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  v_enforce := (p_agent_slug = 'engineer')
    and not _credits_enforced(p_tenant_id)
    and coalesce((select (blob->>'build_credits_enforced')::boolean
                  from system_config where id = 1), false);
  if v_enforce then
    if auth.uid() is not null and not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;

    select status, grandfathered, plan into v_status, v_gf, v_plan
    from tenant_subscriptions where tenant_id = p_tenant_id;
    if v_status is not null and v_status in ('canceled', 'incomplete') then
      raise exception 'build_credits_locked' using errcode = 'P0001';
    end if;

    v_allow := case
      when v_gf then 250
      when v_plan = 'solo' then 50
      when v_plan = 'team' then 250
      when v_plan = 'full' then 1000
      when v_plan = 'enterprise' then 1000000
      else 5
    end;

    insert into tenant_build_credits (tenant_id, period_start, period_end, included_allowance)
    values (p_tenant_id,
            date_trunc('month', current_date)::date,
            (date_trunc('month', current_date) + interval '1 month')::date,
            v_allow)
    on conflict (tenant_id) do nothing;

    perform 1 from tenant_build_credits where tenant_id = p_tenant_id for update;
    update tenant_build_credits
       set period_start       = case when current_date >= period_end
                                     then date_trunc('month', current_date)::date
                                     else period_start end,
           period_end         = case when current_date >= period_end
                                     then (date_trunc('month', current_date) + interval '1 month')::date
                                     else period_end end,
           included_used      = case when current_date >= period_end then 0 else included_used end,
           included_allowance = v_allow,
           updated_at         = now()
     where tenant_id = p_tenant_id;

    select included_used, included_allowance, purchased_balance
      into v_iu, v_ia, v_pb
    from tenant_build_credits where tenant_id = p_tenant_id;
    if v_iu < v_ia then
      update tenant_build_credits set included_used = included_used + 1, updated_at = now()
      where tenant_id = p_tenant_id;
      v_source := 'included';
    elsif v_pb > 0 then
      update tenant_build_credits set purchased_balance = purchased_balance - 1, updated_at = now()
      where tenant_id = p_tenant_id;
      v_source := 'purchased';
    else
      raise exception 'insufficient_build_credits' using errcode = 'P0001';
    end if;
  end if;

  if p_cron_dedupe_key is null then
    insert into agent_runs (
      tenant_id, agent_slug, agent_definition_hash, trigger,
      status, enqueued_by, cron_dedupe_key, payload
    )
    values (
      p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
      'queued', auth.uid(), null, p_payload
    )
    returning id into v_run_id;
  else
    insert into agent_runs (
      tenant_id, agent_slug, agent_definition_hash, trigger,
      status, enqueued_by, cron_dedupe_key, payload
    )
    values (
      p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
      'queued', auth.uid(), p_cron_dedupe_key, p_payload
    )
    on conflict (cron_dedupe_key) where cron_dedupe_key is not null do nothing
    returning id into v_run_id;
  end if;

  if v_enforce then
    if v_run_id is null then
      raise exception 'enqueue_deduped_no_run' using errcode = 'P0001';
    end if;
    insert into tenant_build_credit_ledger (run_id, tenant_id, agent_slug, amount, source, period_start)
    select v_run_id, p_tenant_id, p_agent_slug, 1, v_source, period_start
    from tenant_build_credits where tenant_id = p_tenant_id;
  end if;

  return v_run_id;
end $$;

revoke all on function enqueue_agent_run(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to authenticated, service_role;

create table if not exists setup_draft_admissions (
  run_id     uuid primary key references agent_runs(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  attempt    int not null check (attempt between 1 and 3),
  bridged    int not null default 0 check (bridged >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt)
);
alter table setup_draft_admissions enable row level security;
revoke all on table setup_draft_admissions from anon, authenticated;

create or replace function enqueue_setup_draft(
  p_tenant_id  uuid,
  p_agent_hash text,
  p_payload    jsonb,
  p_attempt    int
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key    text;
  v_est    int;
  v_avail  int;
  v_bridge int := 0;
  v_run    uuid;
begin
  if auth.uid() is not null then
    raise exception 'enqueue_setup_draft: service role only' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_attempt is null or p_attempt not between 1 and 3 then
    raise exception 'enqueue_setup_draft: tenant and attempt 1-3 required' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'stage' is distinct from 'draft_strategy'
     or p_payload->>'origin' is distinct from 'setup_draft'
     or exists (select 1 from jsonb_object_keys(p_payload) k
                 where k not in ('stage', 'origin', 'research', 'past_work')) then
    raise exception 'enqueue_setup_draft: not a setup draft payload' using errcode = '22023';
  end if;
  v_key := 'cgo:draft:' || p_tenant_id::text || ':setup'
           || case when p_attempt = 1 then '' else ':' || p_attempt::text end;

  if _credits_enforced(p_tenant_id) then
    v_est := _reserve_estimate_for('cgo');
    perform _credit_balance_touch(p_tenant_id);
    select (included_allowance - included_used)
           + greatest(daily_allowance - daily_used, 0)
           + purchased_balance - reserved
      into v_avail
      from tenant_credit_balances where tenant_id = p_tenant_id;
    v_bridge := greatest(v_est - coalesce(v_avail, 0), 0);
    if v_bridge > 0 then
      update tenant_credit_balances
         set purchased_balance = purchased_balance + v_bridge
       where tenant_id = p_tenant_id;
    end if;
  end if;

  v_run := enqueue_agent_run(p_tenant_id, 'cgo', p_agent_hash, 'a2a', p_payload, v_key);

  if v_run is not null then
    insert into setup_draft_admissions (run_id, tenant_id, attempt, bridged)
    values (v_run, p_tenant_id, p_attempt, v_bridge);
  end if;

  if v_bridge > 0 then
    update tenant_credit_balances
       set purchased_balance = purchased_balance - v_bridge
     where tenant_id = p_tenant_id;
  end if;
  return v_run;
end $$;
revoke all on function enqueue_setup_draft(uuid, text, jsonb, int) from public, anon, authenticated;
grant execute on function enqueue_setup_draft(uuid, text, jsonb, int) to service_role;

create or replace function setup_draft_resolve_run(p_run_id uuid)
returns table (
  tenant_id uuid, status text, agent_slug text, trigger text,
  enqueued_by_is_null boolean, cron_dedupe_key text, attempt int
)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.tenant_id, r.status, r.agent_slug, r.trigger, r.enqueued_by is null, r.cron_dedupe_key, a.attempt
    from agent_runs r
    join setup_draft_admissions a on a.run_id = r.id and a.tenant_id = r.tenant_id
   where r.id = p_run_id
$$;
revoke all on function setup_draft_resolve_run(uuid) from public, anon, authenticated;
grant execute on function setup_draft_resolve_run(uuid) to service_role;

alter function grant_promo_credits(uuid, int, text, text, text) set search_path = public, pg_temp;
revoke all on function grant_promo_credits(uuid, int, text, text, text) from public, anon, authenticated;
grant execute on function grant_promo_credits(uuid, int, text, text, text) to service_role;

commit;
