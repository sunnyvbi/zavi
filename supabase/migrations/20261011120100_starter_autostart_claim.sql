
create table if not exists public.starter_autostart_claims (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  action_id  uuid not null,
  run_id     uuid,
  claimed_at timestamptz not null default now()
);
alter table public.starter_autostart_claims enable row level security;
revoke all on public.starter_autostart_claims from public, anon, authenticated;

insert into public.starter_autostart_claims (tenant_id, action_id, run_id, claimed_at)
select distinct on (e.tenant_id) e.tenant_id, e.action_id, e.run_id, e.at
  from public.channel_action_events e
 where e.event = 'approved' and e.event_key like 'starter-%'
 order by e.tenant_id, e.at, e.id
on conflict (tenant_id) do nothing;

create or replace function public.claim_starter_autostart(
  p_tenant_id uuid,
  p_action_id uuid,
  p_run_id    uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  if p_tenant_id is null or p_action_id is null then
    raise exception 'claim_starter_autostart: tenant_id and action_id required' using errcode = '22023';
  end if;
  if not exists (select 1 from channel_actions where id = p_action_id and tenant_id = p_tenant_id) then
    raise exception 'tenant_mismatch' using errcode = '42501';
  end if;
  insert into starter_autostart_claims (tenant_id, action_id, run_id)
  select p_tenant_id,
         coalesce((select e.action_id
                     from channel_action_events e
                    where e.tenant_id = p_tenant_id
                      and e.event = 'approved'
                      and e.event_key like 'starter-%'
                    order by e.at, e.id
                    limit 1), p_action_id),
         p_run_id
  on conflict (tenant_id) do nothing;
  select action_id into v_owner from starter_autostart_claims where tenant_id = p_tenant_id;
  return v_owner = p_action_id;
end $$;
revoke all on function public.claim_starter_autostart(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_starter_autostart(uuid, uuid, uuid) to service_role;
