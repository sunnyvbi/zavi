begin;

create table if not exists public.site_page_views (
  id            bigint      generated always as identity primary key,
  site_id       uuid        not null references public.sites (id) on delete cascade,
  tenant_id     uuid        not null references public.tenants (id) on delete cascade,
  at            timestamptz not null default now(),
  path          text        not null check (path ~ '^/' and length(path) <= 200),
  referrer_host text        check (length(referrer_host) <= 255),
  source        text        check (length(source) <= 100),
  visitor       text        not null check (visitor ~ '^[0-9a-f]{32}$'),
  device        text        not null check (device in ('mobile', 'tablet', 'desktop')),
  country       text        check (country ~ '^[A-Z]{2}$')
);

create index if not exists site_page_views_site_at on public.site_page_views (site_id, at);
create index if not exists site_page_views_tenant on public.site_page_views (tenant_id);

alter table public.site_page_views enable row level security;
revoke all on table public.site_page_views from public, anon, authenticated;
grant all on table public.site_page_views to service_role;

create or replace function public.site_traffic_stats(
  p_tenant_id uuid,
  p_site_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_tz text
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if p_tenant_id is null or p_site_id is null or p_since is null or p_until is null or p_prev_since is null
     or p_prev_since > p_since or p_since >= p_until or p_until - p_prev_since > interval '800 days' then
    raise exception 'invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;
  with site_rows as (
    select pv.path, pv.referrer_host, pv.source, pv.visitor, pv.at
      from public.site_page_views pv
     where pv.site_id = p_site_id and pv.tenant_id = p_tenant_id
       and pv.at >= p_prev_since - interval '1 day' and pv.at < p_until
  ), firsts as (
    select distinct on (r.visitor) r.visitor, r.at,
           coalesce(nullif(r.source, ''), r.referrer_host) as src
      from site_rows r
     order by r.visitor, r.at
  ), visits as (
    select f.visitor, f.src, (f.at at time zone p_tz)::date as d
      from firsts f
     where f.at >= p_since and f.at < p_until
  ), views as (
    select r.path, r.visitor, (r.at at time zone p_tz)::date as d
      from site_rows r
     where r.at >= p_since and r.at < p_until
  ), days as (
    select d from visits union select d from views
  )
  select jsonb_build_object(
    'pageviews', (select count(*) from views),
    'visits', (select count(*) from visits),
    'previous_visits', (select count(*) from firsts f where f.at >= p_prev_since and f.at < p_since),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', to_char(x.d, 'YYYY-MM-DD'),
               'visits', (select count(*) from visits vi where vi.d = x.d),
               'pageviews', (select count(*) from views vw where vw.d = x.d)) order by x.d)
        from days x), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object('path', t.path, 'pageviews', t.pageviews, 'visits', t.visits) order by t.pageviews desc, t.path)
        from (select vw.path, count(*) as pageviews, count(distinct vw.visitor) as visits
                from views vw group by vw.path order by count(*) desc, vw.path limit 10) t), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', t.src, 'visits', t.visits) order by t.visits desc, t.src nulls first)
        from (select vi.src, count(*) as visits from visits vi group by vi.src order by count(*) desc, vi.src nulls first limit 10) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.site_traffic_stats(uuid, uuid, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.site_traffic_stats(uuid, uuid, timestamptz, timestamptz, timestamptz, text) to service_role;

commit;
