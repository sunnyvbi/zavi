create table if not exists public.connector_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null,
  action text not null check (action in ('connect', 'disconnect')),
  actor_user_id uuid,
  meta jsonb not null default '{}'::jsonb
    check (jsonb_typeof(meta) = 'object' and (meta - array['account_label', 'via']) = '{}'::jsonb),
  created_at timestamptz not null default now()
);
comment on table public.connector_events is
  'Connect / disconnect audit per tenant connector. Server only (service role); staff-readable, never tenant-readable.';
alter table public.connector_events enable row level security;
revoke all on public.connector_events from public, anon, authenticated;
grant select, insert, update on public.connector_events to service_role;

create or replace function public.log_connector_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.connector_metadata;
  act text;
begin
  if tg_op = 'DELETE' then
    r := old; act := 'disconnect';
  elsif tg_op = 'INSERT' then
    r := new; act := 'connect';
  elsif new.connected_at is distinct from old.connected_at or new.team_id is distinct from old.team_id then
    r := new; act := 'connect';
  else
    return null;
  end if;
  if not exists (select 1 from public.tenants t where t.id = r.tenant_id) then
    return null;
  end if;
  begin
    insert into public.connector_events (tenant_id, slug, action, actor_user_id, meta)
    values (r.tenant_id, r.slug, act, auth.uid(),
            jsonb_strip_nulls(jsonb_build_object('via', 'db', 'account_label', left(r.team_name, 200))));
  exception when others then
    raise warning 'connector_events not recorded for % %: %', r.slug, act, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.log_connector_event() from public, anon, authenticated;

drop trigger if exists connector_metadata_log_event on public.connector_metadata;
create trigger connector_metadata_log_event
  after insert or update or delete on public.connector_metadata
  for each row execute function public.log_connector_event();
