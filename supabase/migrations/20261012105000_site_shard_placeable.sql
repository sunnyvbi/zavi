
begin;

create or replace function public.site_shard_placeable(sh public.site_shards) returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select coalesce(
       sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
       and sh.project_ref is not null and sh.url is not null
       and sh.dedicated_site_id is null
       and sh.site_count < sh.max_sites
       and public.site_shard_metrics_fresh(sh)
       and (sh.placement_paused_until is null or sh.placement_paused_until <= now())
       and public.site_shard_load(sh) < sh.fill_ratio,
     false)
$$;

revoke all on function public.site_shard_placeable(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_placeable(public.site_shards) to service_role;

create or replace function public.site_shard_placement_readiness(p_env text)
returns table (open_count integer, placeable_count integer, stale_count integer, paused_count integer)
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select (count(*) filter (where o.is_open))::integer,
         (count(*) filter (where public.site_shard_placeable(sh)))::integer,
         (count(*) filter (where o.is_open and not public.site_shard_metrics_fresh(sh)))::integer,
         (count(*) filter (where o.is_open and sh.placement_paused_until > now()))::integer
    from public.site_shards sh
    cross join lateral (
      select coalesce(
           sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
           and sh.project_ref is not null and sh.url is not null
           and sh.dedicated_site_id is null
           and sh.site_count < sh.max_sites,
         false) as is_open
    ) o
   where sh.env = p_env
$$;

revoke all on function public.site_shard_placement_readiness(text) from public, anon, authenticated;
grant execute on function public.site_shard_placement_readiness(text) to service_role;

commit;
