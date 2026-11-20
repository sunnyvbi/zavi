create table if not exists public.tiktok_scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  scheduled_at timestamptz not null,
  timezone text not null default 'UTC',
  content jsonb not null,
  status text not null default 'scheduled' check (status in ('scheduled','publishing','processing','published','failed','cancelled')),
  publish_id text,
  external_post_ids text[] not null default '{}',
  failure_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists tiktok_scheduled_due_idx on public.tiktok_scheduled_posts(scheduled_at) where status='scheduled';
alter table public.tiktok_scheduled_posts enable row level security;
create policy "tiktok_posts_tenant_select" on public.tiktok_scheduled_posts for select to authenticated
  using (exists (select 1 from public.tenant_users tu where tu.user_id=auth.uid() and tu.tenant_id=tiktok_scheduled_posts.tenant_id));

create or replace function public.set_tiktok_connection(
  p_tenant_id uuid, p_access_token text, p_refresh_token text, p_open_id text,
  p_scopes text[], p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare k record; old_id uuid; new_id uuid;
begin
  for k in select * from (values ('tiktok.access_token',p_access_token),('tiktok.refresh_token',p_refresh_token)) x(key,value) loop
    select vault_secret_id into old_id from secrets where tenant_id=p_tenant_id and key=k.key;
    if old_id is not null then perform vault.delete_secret(old_id); delete from secrets where tenant_id=p_tenant_id and key=k.key; end if;
    new_id := vault.create_secret(k.value);
    insert into secrets(tenant_id,key,vault_secret_id) values(p_tenant_id,k.key,new_id);
  end loop;
  insert into connector_metadata(tenant_id,slug,team_id,team_name,scopes,connected_at,token_expires_at)
  values(p_tenant_id,'tiktok',p_open_id,'TikTok',p_scopes,now(),p_expires_at)
  on conflict(tenant_id,slug) do update set team_id=excluded.team_id,scopes=excluded.scopes,connected_at=excluded.connected_at,token_expires_at=excluded.token_expires_at;
  insert into tenant_mcp_servers(tenant_id,server_id,transport,enabled) values(p_tenant_id,'tiktok','internal',true)
  on conflict(tenant_id,server_id) do update set transport='internal',enabled=true;
end $$;
revoke all on function public.set_tiktok_connection(uuid,text,text,text,text[],timestamptz) from public;
grant execute on function public.set_tiktok_connection(uuid,text,text,text,text[],timestamptz) to service_role;

create or replace function public.refresh_tiktok_connection(p_tenant_id uuid,p_access_token text,p_refresh_token text,p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare k record; old_id uuid; new_id uuid;
begin
  for k in select * from (values ('tiktok.access_token',p_access_token),('tiktok.refresh_token',p_refresh_token)) x(key,value) loop
    select vault_secret_id into old_id from secrets where tenant_id=p_tenant_id and key=k.key;
    if old_id is not null then perform vault.delete_secret(old_id); delete from secrets where tenant_id=p_tenant_id and key=k.key; end if;
    new_id := vault.create_secret(k.value); insert into secrets(tenant_id,key,vault_secret_id) values(p_tenant_id,k.key,new_id);
  end loop;
  update connector_metadata set token_expires_at=p_expires_at where tenant_id=p_tenant_id and slug='tiktok';
end $$;
revoke all on function public.refresh_tiktok_connection(uuid,text,text,timestamptz) from public;
grant execute on function public.refresh_tiktok_connection(uuid,text,text,timestamptz) to service_role;

create or replace function public.tiktok_publish_claim(p_post_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update tiktok_scheduled_posts set status='publishing',updated_at=now() where id=p_post_id and status='scheduled' and scheduled_at<=now();
  return found;
end $$;
revoke all on function public.tiktok_publish_claim(uuid) from public;
grant execute on function public.tiktok_publish_claim(uuid) to service_role;

create or replace function public.tiktok_publish_finalize(p_post_id uuid,p_publish_id text,p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update tiktok_scheduled_posts set status=case when p_publish_id is not null then 'processing' else 'failed' end,
    publish_id=p_publish_id,failure_reason=p_error,updated_at=now() where id=p_post_id and status='publishing';
end $$;
revoke all on function public.tiktok_publish_finalize(uuid,text,text) from public;
grant execute on function public.tiktok_publish_finalize(uuid,text,text) to service_role;
