begin;

create table if not exists public.tenant_email_pause (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  paused     boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.tenant_email_pause enable row level security;
revoke all on public.tenant_email_pause from public, anon, authenticated;

create or replace function public.email_send_paused(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.paused from tenant_email_pause p where p.tenant_id = p_tenant_id), false);
$$;
revoke all on function public.email_send_paused(uuid) from public, anon, authenticated;
grant execute on function public.email_send_paused(uuid) to service_role;

create or replace function public.set_email_pause(p_tenant_id uuid, p_actor_user_id uuid, p_paused boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_resumed uuid[] := '{}';
begin
  if p_tenant_id is null or p_actor_user_id is null or p_paused is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  insert into tenant_email_pause (tenant_id, paused, updated_by, updated_at)
  values (p_tenant_id, p_paused, p_actor_user_id, now())
  on conflict (tenant_id) do update set paused = excluded.paused, updated_by = excluded.updated_by, updated_at = now();
  if not p_paused then
    with resumed as (
      update email_bulk_sends s
         set status = 'sending', hold_reason = null, next_run_at = null
       where s.tenant_id = p_tenant_id and s.status = 'held' and s.hold_reason = 'email_paused'
      returning s.id
    )
    select coalesce(array_agg(id), '{}') into v_resumed from resumed;
  end if;
  return jsonb_build_object('ok', true, 'paused', p_paused, 'resumed', to_jsonb(v_resumed));
end $$;
revoke all on function public.set_email_pause(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_email_pause(uuid, uuid, boolean) to service_role;

commit;
