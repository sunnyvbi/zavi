
create table team_members (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  display_name    text not null,
  primary_email   text,
  kind            text not null default 'human'
                  check (kind in ('human','bot','service_account')),
  status          text not null default 'active'
                  check (status in ('active','deactivated','merged_into')),
  merged_into_id  uuid references team_members(id),
  deactivated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index team_members_tenant_email_lower_uniq
  on team_members (tenant_id, lower(primary_email))
  where primary_email is not null and status = 'active';

create index team_members_tenant_status_idx
  on team_members (tenant_id, status);

alter table team_members enable row level security;
create policy team_members_member_select on team_members
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = team_members.tenant_id)
  );

create table team_member_identities (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  member_id               uuid not null references team_members(id) on delete cascade,
  provider                text not null check (provider in ('github','jira','slack')),
  external_id             text not null,
  external_email          text,
  external_display_name   text,
  confidence              numeric(3,2) not null default 1.00,
  source                  text not null default 'auto'
                          check (source in ('auto','admin','oauth_self')),
  linked_at               timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);

create index team_member_identities_member_idx
  on team_member_identities (tenant_id, member_id);
create index team_member_identities_provider_idx
  on team_member_identities (tenant_id, provider);

alter table team_member_identities enable row level security;
create policy team_member_identities_member_select on team_member_identities
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = team_member_identities.tenant_id)
  );

create table team_discover_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  triggered_by    uuid references auth.users(id),
  status          text not null default 'queued'
                  check (status in ('queued','running','done','error')),
  providers       text[] not null default array[]::text[],
  results         jsonb,
  error_reason    text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index team_discover_jobs_tenant_created_idx
  on team_discover_jobs (tenant_id, created_at desc);

alter table team_discover_jobs enable row level security;
create policy team_discover_jobs_member_select on team_discover_jobs
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = team_discover_jobs.tenant_id)
  );

create or replace function list_team_members()
returns table (
  id uuid,
  display_name text,
  primary_email text,
  kind text,
  status text,
  identities jsonb,
  ambiguous_count int
)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  return query
  select tm.id, tm.display_name, tm.primary_email, tm.kind, tm.status,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'provider', i.provider,
             'external_id', i.external_id,
             'external_display_name', i.external_display_name,
             'confidence', i.confidence,
             'source', i.source
           ) order by i.provider)
           from team_member_identities i
           where i.member_id = tm.id
         ), '[]'::jsonb),
         coalesce((
           select count(*)::int from team_member_identities i
           where i.member_id = tm.id and i.confidence < 1.00 and i.source = 'auto'
         ), 0)
    from team_members tm
    where tm.tenant_id = v_tenant and tm.status = 'active'
    order by tm.display_name;
end $$;

create or replace function get_team_member_detail(p_member_id uuid)
returns table (
  id uuid,
  display_name text,
  primary_email text,
  kind text,
  status text,
  identities jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  return query
  select tm.id, tm.display_name, tm.primary_email, tm.kind, tm.status,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'provider', i.provider,
             'external_id', i.external_id,
             'external_email', i.external_email,
             'external_display_name', i.external_display_name,
             'confidence', i.confidence,
             'source', i.source
           ) order by i.provider)
           from team_member_identities i
           where i.member_id = tm.id
         ), '[]'::jsonb)
    from team_members tm
    where tm.tenant_id = v_tenant and tm.id = p_member_id and tm.status = 'active';
end $$;

create or replace function trigger_team_discover(
  p_providers text[] default array['github','slack','jira']
)
returns table (job_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_existing_id uuid;
  v_new_id uuid;
begin
  if p_providers is null or array_length(p_providers, 1) is null then
    raise exception 'providers must be non-empty' using errcode = '22023';
  end if;
  if not (p_providers <@ array['github','slack','jira']::text[]) then
    raise exception 'invalid provider in array' using errcode = '22023';
  end if;

  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  select id into v_existing_id from team_discover_jobs
   where tenant_id = v_tenant and status in ('queued','running')
   order by created_at desc limit 1;
  if v_existing_id is not null then
    return query select v_existing_id, false;
    return;
  end if;

  insert into team_discover_jobs (tenant_id, triggered_by, providers)
  values (v_tenant, auth.uid(), p_providers)
  returning id into v_new_id;
  return query select v_new_id, true;
end $$;

create or replace function update_team_member(
  p_member_id uuid,
  p_display_name text default null,
  p_primary_email text default null,
  p_kind text default null
) returns team_members
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row team_members;
  v_email_normalized text;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_kind is not null and p_kind not in ('human','bot','service_account') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  v_email_normalized := nullif(lower(trim(p_primary_email)), '');

  update team_members
     set display_name  = coalesce(nullif(trim(p_display_name), ''), display_name),
         primary_email = coalesce(v_email_normalized, primary_email),
         kind          = coalesce(p_kind, kind),
         updated_at    = now()
   where id = p_member_id and tenant_id = v_tenant
   returning * into v_row;
  if not found then raise exception 'member not found' using errcode = '42704'; end if;
  return v_row;
end $$;

create or replace function merge_team_members(p_keep_id uuid, p_drop_id uuid)
returns team_members
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_keep team_members;
  v_drop team_members;
begin
  if p_keep_id = p_drop_id then raise exception 'cannot merge member with itself' using errcode = '22023'; end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  select * into v_keep from team_members
   where id = p_keep_id and tenant_id = v_tenant for update;
  if not found or v_keep.status <> 'active' then
    raise exception 'keep member not found or not active' using errcode = '42704';
  end if;
  select * into v_drop from team_members
   where id = p_drop_id and tenant_id = v_tenant for update;
  if not found or v_drop.status <> 'active' then
    raise exception 'drop member not found or not active' using errcode = '42704';
  end if;

  delete from team_member_identities
   where member_id = p_drop_id and tenant_id = v_tenant
     and (provider, external_id) in (
       select provider, external_id from team_member_identities
       where member_id = p_keep_id and tenant_id = v_tenant
     );

  update team_member_identities
     set member_id = p_keep_id, source = 'admin'
   where member_id = p_drop_id and tenant_id = v_tenant;

  update team_members
     set status = 'merged_into', merged_into_id = p_keep_id, updated_at = now()
   where id = p_drop_id and tenant_id = v_tenant;

  update team_members set updated_at = now()
   where id = p_keep_id and tenant_id = v_tenant
   returning * into v_keep;
  return v_keep;
end $$;

revoke all on function list_team_members() from public;
revoke all on function get_team_member_detail(uuid) from public;
revoke all on function trigger_team_discover(text[]) from public;
revoke all on function update_team_member(uuid, text, text, text) from public;
revoke all on function merge_team_members(uuid, uuid) from public;
grant execute on function list_team_members() to authenticated;
grant execute on function get_team_member_detail(uuid) to authenticated;
grant execute on function trigger_team_discover(text[]) to authenticated;
grant execute on function update_team_member(uuid, text, text, text) to authenticated;
grant execute on function merge_team_members(uuid, uuid) to authenticated;
