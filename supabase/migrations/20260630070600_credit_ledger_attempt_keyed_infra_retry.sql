
alter table tenant_credit_ledger add column if not exists attempt int not null default 0;

drop index if exists tcl_run_reserve_uq;
drop index if exists tcl_run_terminal_uq;
create unique index if not exists tcl_run_attempt_reserve_uq
  on tenant_credit_ledger (run_id, attempt) where kind = 'reserve';
create unique index if not exists tcl_run_attempt_terminal_uq
  on tenant_credit_ledger (run_id, attempt) where kind in ('settle','refund');

drop function if exists reserve_run_credits(uuid, uuid, text, int);
create or replace function reserve_run_credits(
  p_tenant_id  uuid,
  p_run_id     uuid,
  p_agent_slug text,
  p_estimate   int,
  p_attempt    int
) returns boolean
language plpgsql security definer set search_path = public as $$
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

  if v_avail < p_estimate then
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

create or replace function finalize_run_credits(
  p_run_id          uuid,
  p_cost_usd        numeric,
  p_terminal_reason text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_held     int;
  v_ps       date;
  v_attempt  int;
  v_credits  int;
  v_ia       int;
  v_iu       int;
  v_room     int;
  v_from_inc int;
  v_from_pur int;
  v_inserted int;
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
  select included_allowance, included_used into v_ia, v_iu
  from tenant_credit_balances where tenant_id = v_tenant;
  v_room     := greatest(v_ia - v_iu, 0);
  v_from_inc := least(v_credits, v_room);
  v_from_pur := v_credits - v_from_inc;

  insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, attempt)
  values (v_tenant, p_run_id, 'settle', v_credits,
          case when v_from_pur = 0 then 'included' when v_from_inc = 0 then 'purchased' else 'mixed' end,
          null, p_cost_usd, v_ps, v_attempt)
  on conflict (run_id, attempt) where kind in ('settle','refund') do nothing
  returning 1 into v_inserted;
  if v_inserted is null then
    return 'noop';
  end if;

  update tenant_credit_balances
     set reserved          = greatest(reserved - v_held, 0),
         included_used     = included_used + v_from_inc,
         purchased_balance = purchased_balance - v_from_pur,
         updated_at        = now()
   where tenant_id = v_tenant;

  return 'settled';
end $$;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if NEW.status in ('queued', 'running') then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

create or replace function _trg_rereserve_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;
drop trigger if exists trg_agent_runs_rereserve_credits on agent_runs;
create trigger trg_agent_runs_rereserve_credits
  after update of status on agent_runs
  for each row execute function _trg_rereserve_run_credits();

create or replace function _trg_finalize_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id)
     and not exists (
       select 1 from tenant_credit_ledger r
       where r.run_id = NEW.id and r.kind = 'reserve'
         and not exists (
           select 1 from tenant_credit_ledger t
           where t.run_id = NEW.id and t.kind in ('settle','refund') and t.attempt = r.attempt
         )
     ) then
    return null;
  end if;
  if OLD.status in ('queued','running','blocked')
     and NEW.status in ('success','parse_failed','error','failed','cancelled','dispatch_error') then
    perform finalize_run_credits(NEW.id, NEW.cost_usd, NEW.status);
  end if;
  return null;
end $$;

do $$
begin
  raise notice '20260630070600: credit ledger attempt-keyed; re-reserve on terminal→queued; finalize releases open reserve';
end $$;
