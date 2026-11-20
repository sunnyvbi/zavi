
alter table tenants
  add column if not exists credits_unlimited boolean not null default false;

comment on column tenants.credits_unlimited is
  'Staff-set: exempt this tenant from the reserve_run_credits availability check. '
  'Runs are still metered + settled (purchased_balance absorbs the overdraft); they are never rejected. '
  'Set only via set_tenant_credits_unlimited, which audits to admin_action_log.';

create index if not exists tenants_credits_unlimited_idx
  on tenants (id) where credits_unlimited;

create or replace function _credits_unlimited(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select credits_unlimited from tenants where id = p_tenant_id), false);
$$;

create or replace function reserve_run_credits(
  p_tenant_id  uuid,
  p_run_id     uuid,
  p_agent_slug text,
  p_estimate   int,
  p_attempt    int
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_avail int;
  v_ps    date;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'reserve_run_credits: tenant_id and run_id required' using errcode = '22023';
  end if;
  if p_estimate is null or p_estimate < 0 then
    raise exception 'reserve_run_credits: estimate must be >= 0' using errcode = '22023';
  end if;
  if p_attempt is null or p_attempt < 0 then
    raise exception 'reserve_run_credits: attempt must be >= 0' using errcode = '22023';
  end if;

  perform _credit_balance_touch(p_tenant_id);

  if exists (select 1 from tenant_credit_ledger
             where run_id = p_run_id and kind = 'reserve' and attempt = p_attempt) then
    return false;
  end if;

  select (included_allowance - included_used) + purchased_balance - reserved, period_start
    into v_avail, v_ps
  from tenant_credit_balances where tenant_id = p_tenant_id;

  if v_avail < p_estimate and not _credits_unlimited(p_tenant_id) then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  update tenant_credit_balances
     set reserved = reserved + p_estimate, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, agent_slug, period_start, attempt)
  values (p_tenant_id, p_run_id, 'reserve', p_estimate, p_agent_slug, v_ps, p_attempt)
  on conflict (run_id, attempt) where kind = 'reserve' do nothing;

  return true;
end $$;
revoke all on function reserve_run_credits(uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function reserve_run_credits(uuid, uuid, text, int, int) to service_role;

create or replace function set_tenant_credits_unlimited(
  p_tenant_id   uuid,
  p_unlimited   boolean,
  p_reason      text,
  p_actor_email text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_before boolean;
begin
  if p_tenant_id is null or p_unlimited is null
     or length(coalesce(p_reason, '')) = 0 or p_actor_email is null then
    raise exception 'set_tenant_credits_unlimited: tenant_id, unlimited, reason, actor required'
      using errcode = '22023';
  end if;

  select credits_unlimited into v_before from tenants where id = p_tenant_id for update;
  if v_before is null then
    raise exception 'set_tenant_credits_unlimited: no such tenant' using errcode = '22023';
  end if;
  if v_before = p_unlimited then
    return false;
  end if;

  update tenants set credits_unlimited = p_unlimited where id = p_tenant_id;

  insert into admin_action_log (staff_email, tenant_id, action, target, after_state, on_behalf)
  values (p_actor_email, p_tenant_id,
          case when p_unlimited then 'credits_unlimited_on' else 'credits_unlimited_off' end,
          p_tenant_id::text,
          jsonb_build_object('credits_unlimited', p_unlimited, 'reason', p_reason),
          false);

  return true;
end $$;
revoke all on function set_tenant_credits_unlimited(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function set_tenant_credits_unlimited(uuid, boolean, text, text) to service_role;

do $$
begin
  raise notice '20260829120000: tenants.credits_unlimited added (default false for every tenant); reserve_run_credits skips the availability check for flagged tenants only';
end $$;
