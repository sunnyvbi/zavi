
alter table tenant_credit_ledger drop constraint if exists tenant_credit_ledger_kind_check;
alter table tenant_credit_ledger
  add constraint tenant_credit_ledger_kind_check
  check (kind in ('reserve','settle','refund','topup','topup_revoke','grant','media'));

alter table tenant_credit_ledger add column if not exists media_key text;
create unique index if not exists tenant_credit_ledger_media_key_uq
  on tenant_credit_ledger (media_key)
  where kind = 'media' and media_key is not null;

create or replace function media_credits_affordable(p_tenant_id uuid, p_cost_usd numeric)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_avail int;
begin
  if p_tenant_id is null then
    raise exception 'media_credits_affordable: tenant_id required' using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd <= 0 then return true; end if;
  if not _credits_enforced(p_tenant_id) then return true; end if;
  if _credits_unlimited(p_tenant_id) then return true; end if;
  perform _credit_balance_touch(p_tenant_id);
  select (included_allowance - included_used)
         + greatest(daily_allowance - daily_used, 0)
         + purchased_balance - reserved
    into v_avail
  from tenant_credit_balances where tenant_id = p_tenant_id;
  return coalesce(v_avail, 0) >= ceil(p_cost_usd / 0.0025)::int;
end $$;
revoke all on function media_credits_affordable(uuid, numeric) from public, anon, authenticated;
grant execute on function media_credits_affordable(uuid, numeric) to service_role;

create or replace function charge_media_credits(
  p_tenant_id uuid,
  p_media_key text,
  p_cost_usd  numeric,
  p_task      text,
  p_model     text,
  p_run_id    uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_tenant uuid;
  v_ps date; v_credits int; v_ia int; v_iu int; v_da int; v_du int; v_pb int;
  v_daily_room int; v_room int; v_from_day int; v_from_inc int; v_from_pur int; v_rem int;
  v_inserted int;
begin
  if p_tenant_id is null or p_media_key is null or length(p_media_key) = 0 then
    raise exception 'charge_media_credits: tenant_id and media_key required' using errcode = '22023';
  end if;
  if p_run_id is not null then
    select tenant_id into v_run_tenant from agent_runs where id = p_run_id;
    if v_run_tenant is distinct from p_tenant_id then
      raise exception 'tenant_mismatch' using errcode = '42501';
    end if;
  end if;
  if p_cost_usd is null or p_cost_usd <= 0 then return 'zero'; end if;
  if not _credits_enforced(p_tenant_id) then return 'not_enforced'; end if;

  perform _credit_balance_touch(p_tenant_id);
  select period_start, included_allowance, included_used, daily_allowance, daily_used, purchased_balance
    into v_ps, v_ia, v_iu, v_da, v_du, v_pb
  from tenant_credit_balances where tenant_id = p_tenant_id for update;

  v_credits    := ceil(p_cost_usd / 0.0025)::int;
  v_daily_room := greatest(v_da - v_du, 0);
  v_from_day   := least(v_credits, v_daily_room);
  v_rem        := v_credits - v_from_day;
  v_room       := greatest(v_ia - v_iu, 0);
  v_from_inc   := least(v_rem, v_room);
  v_from_pur   := least(v_rem - v_from_inc, greatest(coalesce(v_pb, 0), 0));

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, media_key)
  values (p_tenant_id, p_run_id, 'media', v_credits,
          case when v_from_pur = 0 then 'included'
               when (v_from_day + v_from_inc) = 0 then 'purchased'
               else 'mixed' end,
          left(coalesce(p_task, '') || ':' || coalesce(p_model, ''), 200), p_cost_usd, v_ps, p_media_key)
  on conflict (media_key) where kind = 'media' and media_key is not null
  do nothing
  returning 1 into v_inserted;
  if v_inserted is null then return 'already'; end if;

  update tenant_credit_balances
     set daily_used        = daily_used + v_from_day,
         included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = p_tenant_id;
  return 'charged';
end $$;
revoke all on function charge_media_credits(uuid, text, numeric, text, text, uuid) from public, anon, authenticated;
grant execute on function charge_media_credits(uuid, text, numeric, text, text, uuid) to service_role;
