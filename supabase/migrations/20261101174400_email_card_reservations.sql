
begin;

create table if not exists public.email_card_reservations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  run_id     uuid,
  card_id    uuid,
  created_at timestamptz not null default now()
);
create index if not exists email_card_reservations_tenant_created_idx
  on public.email_card_reservations (tenant_id, created_at);
create index if not exists email_card_reservations_run_idx
  on public.email_card_reservations (tenant_id, run_id) where run_id is not null;
create unique index if not exists email_card_reservations_card_uniq
  on public.email_card_reservations (tenant_id, card_id) where card_id is not null;
alter table public.email_card_reservations enable row level security;
revoke all on table public.email_card_reservations from public, anon, authenticated;

create or replace function public.reserve_email_card(
  p_tenant_id  uuid,
  p_run_id     uuid,
  p_run_cap    int,
  p_tenant_cap int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run    int := 0;
  v_tenant int;
  v_id     uuid;
begin
  if p_tenant_id is null or p_run_cap is null or p_tenant_cap is null
     or p_run_cap < 1 or p_run_cap > 1000 or p_tenant_cap < 1 or p_tenant_cap > 10000 then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_card_cap:' || p_tenant_id::text, 0));
  delete from email_card_reservations r
   where r.tenant_id = p_tenant_id
     and r.created_at < now() - interval '25 hours'
     and (r.run_id is null
          or (r.run_id is distinct from p_run_id
              and not exists (select 1 from agent_runs ar
                               where ar.id = r.run_id and ar.tenant_id = p_tenant_id
                                 and (ar.status is null
                                      or ar.status not in ('success', 'parse_failed', 'dispatch_error', 'error', 'failed', 'cancelled')))));
  if p_run_id is not null then
    select count(*) into v_run from email_card_reservations
     where tenant_id = p_tenant_id and run_id = p_run_id;
    if v_run >= p_run_cap then
      return jsonb_build_object('ok', false, 'code', 'run_cap', 'count', v_run);
    end if;
  end if;
  select count(*) into v_tenant from email_card_reservations
   where tenant_id = p_tenant_id and created_at > now() - interval '24 hours';
  if v_tenant >= p_tenant_cap then
    return jsonb_build_object('ok', false, 'code', 'tenant_cap', 'count', v_tenant);
  end if;
  insert into email_card_reservations (tenant_id, run_id) values (p_tenant_id, p_run_id)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'run_count', v_run + 1, 'tenant_count', v_tenant + 1);
end $$;
revoke all on function public.reserve_email_card(uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.reserve_email_card(uuid, uuid, int, int) to service_role;

create or replace function public.release_email_card_reservation(p_tenant_id uuid, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  delete from email_card_reservations where tenant_id = p_tenant_id and id = p_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'released', v_n > 0);
end $$;
revoke all on function public.release_email_card_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_email_card_reservation(uuid, uuid) to service_role;

create or replace function public.settle_email_card_reservation(p_tenant_id uuid, p_id uuid, p_card_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or p_id is null or p_card_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_card_cap:' || p_tenant_id::text, 0));
  if exists (select 1 from email_card_reservations
              where tenant_id = p_tenant_id and card_id = p_card_id and id <> p_id) then
    delete from email_card_reservations where tenant_id = p_tenant_id and id = p_id;
    get diagnostics v_n = row_count;
    return jsonb_build_object('ok', true, 'released', v_n > 0);
  end if;
  update email_card_reservations set card_id = p_card_id where tenant_id = p_tenant_id and id = p_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'released', false, 'settled', v_n > 0);
end $$;
revoke all on function public.settle_email_card_reservation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_email_card_reservation(uuid, uuid, uuid) to service_role;

commit;
