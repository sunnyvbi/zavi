
create table if not exists public.app_deploys (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null,
  pr_url            text not null,
  github_full_name  text not null,
  merged_sha        text not null,
  render_service_id text,
  state             text not null default 'deploy_watching'
                     check (state in ('deploy_watching', 'deploy_healthy', 'deploy_failed')),
  served_sha        text,
  health_url        text,
  reason            text,
  attempt_count     int not null default 0,
  merged_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, pr_url)
);

comment on table public.app_deploys is
  'C2 deploy-truth state per merged provisioned-app PR: merged SHA vs Render-served SHA + health. deploy_watching->deploy_healthy|deploy_failed. Service-role write via RPCs only.';

alter table public.app_deploys enable row level security;

create or replace function upsert_app_deploy_watch(
  p_tenant_id uuid,
  p_pr_url text,
  p_github_full_name text,
  p_merged_sha text,
  p_render_service_id text,
  p_merged_at timestamptz
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into app_deploys (
    tenant_id, pr_url, github_full_name, merged_sha, render_service_id,
    state, merged_at
  ) values (
    p_tenant_id, p_pr_url, p_github_full_name, p_merged_sha, p_render_service_id,
    'deploy_watching', p_merged_at
  )
  on conflict (tenant_id, pr_url) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from app_deploys
     where tenant_id = p_tenant_id and pr_url = p_pr_url;
  end if;
  return v_id;
end $$;
revoke all on function upsert_app_deploy_watch(uuid, text, text, text, text, timestamptz) from public;
revoke all on function upsert_app_deploy_watch(uuid, text, text, text, text, timestamptz) from authenticated;
grant execute on function upsert_app_deploy_watch(uuid, text, text, text, text, timestamptz) to service_role;

create or replace function set_app_deploy_state(
  p_id bigint,
  p_state text,
  p_served_sha text,
  p_health_url text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if p_state not in ('deploy_healthy', 'deploy_failed') then
    raise exception 'set_app_deploy_state: invalid terminal state %', p_state using errcode = '22023';
  end if;
  update app_deploys
     set state      = p_state,
         served_sha = coalesce(p_served_sha, served_sha),
         health_url = coalesce(p_health_url, health_url),
         reason     = p_reason,
         updated_at = now()
   where id = p_id
     and state = 'deploy_watching';
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
revoke all on function set_app_deploy_state(bigint, text, text, text, text) from public;
revoke all on function set_app_deploy_state(bigint, text, text, text, text) from authenticated;
grant execute on function set_app_deploy_state(bigint, text, text, text, text) to service_role;

create or replace function bump_app_deploy_attempt(
  p_id bigint,
  p_served_sha text,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update app_deploys
     set attempt_count = attempt_count + 1,
         served_sha    = coalesce(p_served_sha, served_sha),
         reason        = p_reason,
         updated_at    = now()
   where id = p_id
     and state = 'deploy_watching';
end $$;
revoke all on function bump_app_deploy_attempt(bigint, text, text) from public;
revoke all on function bump_app_deploy_attempt(bigint, text, text) from authenticated;
grant execute on function bump_app_deploy_attempt(bigint, text, text) to service_role;
