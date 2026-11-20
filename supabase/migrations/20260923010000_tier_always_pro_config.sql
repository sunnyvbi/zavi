
create or replace function _tier_always_pro(p_slug text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when jsonb_typeof(sc.blob->'tier_always_pro') = 'array'
                then (sc.blob->'tier_always_pro') ? p_slug
              else p_slug in ('engineer', 'fundraising', 'supply-demand-balancer')
            end
       from (select 1) one
       left join system_config sc on sc.id = 1),
    false
  );
$$;

revoke all on function _tier_always_pro(text) from public, anon, authenticated;
grant execute on function _tier_always_pro(text) to service_role;
