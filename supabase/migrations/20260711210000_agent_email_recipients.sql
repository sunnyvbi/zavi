
create table if not exists agent_email_recipients (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  email       text        not null,
  label       text,
  created_by  uuid        not null,
  created_at  timestamptz not null default now(),
  constraint agent_email_recipients_email_shape
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create unique index if not exists agent_email_recipients_tenant_email_key
  on agent_email_recipients (tenant_id, lower(email));

alter table agent_email_recipients enable row level security;

create policy agent_email_recipients_member_select on agent_email_recipients
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = agent_email_recipients.tenant_id
    )
  );

revoke all on agent_email_recipients from public;

create or replace function add_agent_email_recipient(
  p_email text,
  p_label text default null
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_email     text := lower(trim(p_email));
  v_count     int;
  v_id        uuid;
  c_max       constant int := 10;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select tu.tenant_id into v_tenant_id
    from public.tenant_users tu
   where tu.user_id = v_user_id
   order by tu.created_at asc
   limit 1;

  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  select count(*) into v_count
    from public.agent_email_recipients r
   where r.tenant_id = v_tenant_id;

  if v_count >= c_max then
    raise exception 'recipient_cap_reached';
  end if;

  insert into public.agent_email_recipients (tenant_id, email, label, created_by)
       values (v_tenant_id, v_email, nullif(trim(coalesce(p_label, '')), ''), v_user_id)
  on conflict (tenant_id, lower(email)) do update
          set label = coalesce(excluded.label, public.agent_email_recipients.label)
    returning id into v_id;

  return v_id;
end;
$$;

revoke all on function add_agent_email_recipient(text, text) from public;
grant execute on function add_agent_email_recipient(text, text) to authenticated;
grant execute on function add_agent_email_recipient(text, text) to service_role;

create or replace function remove_agent_email_recipient(
  p_id uuid
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_deleted   int;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select tu.tenant_id into v_tenant_id
    from public.tenant_users tu
   where tu.user_id = v_user_id
   order by tu.created_at asc
   limit 1;

  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  delete from public.agent_email_recipients r
   where r.id = p_id
     and r.tenant_id = v_tenant_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function remove_agent_email_recipient(uuid) from public;
grant execute on function remove_agent_email_recipient(uuid) to authenticated;
grant execute on function remove_agent_email_recipient(uuid) to service_role;
