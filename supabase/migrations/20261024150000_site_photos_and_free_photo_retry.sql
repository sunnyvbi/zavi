
begin;

alter table public.conductor_runs add column if not exists site_photos jsonb;

create or replace function photo_retry_free(p_tenant_id uuid, p_site_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from sites s
      join conductor_runs r on r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
     where s.id = p_site_id
       and s.tenant_id = p_tenant_id
       and r.site_photos->>'status' = 'missing'
       and r.site_photos->>'free_retry_run_id' is null)
$$;

create or replace function claim_photo_retry(p_tenant_id uuid, p_site_id uuid, p_conductor_run_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_root uuid; v_id uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  select r.id into v_root
    from sites s
    join conductor_runs r on r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and r.site_photos->>'status' = 'missing'
     and r.site_photos->>'free_retry_run_id' is null
   for update of r;
  if v_root is null then
    return false;
  end if;
  update conductor_runs
     set credits_waived = true, updated_at = now()
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id
     and kind = 'build_app'
     and status = 'provisioning'
     and objective like '[refine]%'
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  update conductor_runs
     set site_photos = coalesce(site_photos, '{}'::jsonb) || jsonb_build_object('free_retry_run_id', p_conductor_run_id::text)
   where id = v_root
     and tenant_id = p_tenant_id;
  return true;
end $$;

create or replace function record_site_photos(p_tenant_id uuid, p_site_id uuid, p_photos jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update conductor_runs r
     set site_photos = (p_photos - 'free_retry_run_id')
                       || case when r.site_photos ? 'free_retry_run_id'
                               then jsonb_build_object('free_retry_run_id', r.site_photos->'free_retry_run_id')
                               else '{}'::jsonb end
    from sites s
   where s.id = p_site_id
     and s.tenant_id = p_tenant_id
     and r.id = s.root_conductor_run_id
     and r.tenant_id = p_tenant_id
  returning r.id into v_id;
  return v_id is not null;
end $$;

create or replace function _free_edits_used(p_tenant_id uuid, p_exclude uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  with waived as (
    select c.status = 'done'
           and coalesce((c.goal_graph #>> '{0,payload,no_change}')::boolean, false) as no_op
      from conductor_runs c
     where c.tenant_id = p_tenant_id
       and c.kind = 'build_app'
       and c.credits_waived
       and c.id is distinct from p_exclude
       and coalesce((c.goal_graph #>> '{0,payload,refine_mode}')::boolean, false)
       and not coalesce((c.goal_graph #>> '{0,payload,photo_retry}')::boolean, false)
       and not _is_waived_refine(
             p_tenant_id,
             case when (c.goal_graph #>> '{0,payload,retry_of}')
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (c.goal_graph #>> '{0,payload,retry_of}')::uuid end)
       and (c.status in ('provisioning', 'active')
            or exists (
              select 1 from agent_runs a
               where a.tenant_id = p_tenant_id
                 and a.payload->>'build_conductor_run_id' = c.id::text))
  )
  select ((count(*) filter (where not no_op))
          + greatest(0, (count(*) filter (where no_op)) - 3))::int
    from waived
$$;

revoke all on function _free_edits_used(uuid, uuid) from public, anon, authenticated;
revoke all on function photo_retry_free(uuid, uuid) from public, anon, authenticated;
revoke all on function claim_photo_retry(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function record_site_photos(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function record_site_photos(uuid, uuid, jsonb) to service_role;
grant execute on function photo_retry_free(uuid, uuid) to service_role;
grant execute on function claim_photo_retry(uuid, uuid, uuid) to service_role;

commit;
