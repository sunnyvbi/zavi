
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

create or replace function zsite_auth.site_submission_stats(
  p_site_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_tz text
)
returns table (collection text, via_action boolean, day date, n bigint, prev_n bigint, total_n bigint, last_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_site_id is null or p_since is null or p_until is null or p_prev_since is null or p_tz is null
     or p_prev_since > p_since or p_since >= p_until or p_until - p_prev_since > interval '800 days' then
    raise exception 'invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;
  return query
    with forms as (
      select c.name, false as via_action
        from zsite.collections c
       where c.site_id = p_site_id and c.kind = 'records' and c.archived_at is null
         and coalesce(c.rules->'create' ? 'anyone', false)
    ), actioned as (
      select distinct e.value->'creates'->>'collection' as name, true as via_action
        from zsite.site_contracts sc, pg_catalog.jsonb_each(sc.actions) e
       where sc.site_id = p_site_id and sc.schema_version = 2
         and (coalesce(e.value->'principals' ? 'anyone', false) or coalesce(e.value->'principals' ? 'signed_in', false))
         and e.value->'creates'->>'collection' is not null
    ), counted as (
      select k.name, pg_catalog.bool_or(k.via_action) as via_action
        from (select * from forms union all select * from actioned) k
        join zsite.collections c on c.site_id = p_site_id and c.name = k.name and c.kind = 'records' and c.archived_at is null
       group by k.name
    )
    select k.name, k.via_action, (r.created_at at time zone p_tz)::date, count(*)::bigint, null::bigint, null::bigint, null::timestamptz
      from counted k
      join zsite.records r on r.site_id = p_site_id and r.collection = k.name
     where r.created_at >= p_since and r.created_at < p_until
     group by k.name, k.via_action, (r.created_at at time zone p_tz)::date
    union all
    select k.name, k.via_action, null::date, null::bigint,
           (select count(*) from zsite.records r where r.site_id = p_site_id and r.collection = k.name
               and r.created_at >= p_prev_since and r.created_at < p_since)::bigint,
           (select count(*) from zsite.records r where r.site_id = p_site_id and r.collection = k.name)::bigint,
           (select max(r.created_at) from zsite.records r where r.site_id = p_site_id and r.collection = k.name)
      from counted k;
end $$;

revoke all on function zsite_auth.site_submission_stats(uuid, timestamptz, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function zsite_auth.site_submission_stats(uuid, timestamptz, timestamptz, timestamptz, text) to zsite_broker;

commit;
