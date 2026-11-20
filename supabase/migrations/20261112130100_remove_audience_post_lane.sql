begin;

do $$
begin
  if exists (
    select 1
      from public.creator_orders
     where package_snapshot->>'kind' = 'audience_post'
       and status not in ('completed', 'cancelled')
  ) then
    raise exception 'remove_audience_post_lane: an audience_post creator order is still in flight; close or finish it, then deploy again';
  end if;
end $$;

update creator_packages
   set active = false,
       updated_at = now()
 where kind = 'audience_post'
   and active;

update creator_offers
   set status = 'withdrawn',
       responded_at = now(),
       updated_at = now()
 where kind = 'audience_post'
   and status = 'open';

update brief_applications a
   set status = 'rejected',
       updated_at = now()
 where a.brief_kind = 'creative'
   and a.status in ('applied', 'shortlisted')
   and exists (select 1 from creator_briefs b
                where b.id = a.brief_id
                  and b.tenant_id = a.tenant_id
                  and b.lane = 'audience_post');

update creator_briefs
   set status = case when status = 'draft' then 'cancelled' else status end,
       closed_at = now(),
       updated_at = now()
 where lane = 'audience_post'
   and closed_at is null;

update human_members
   set lanes = array_remove(lanes, 'audience_post'),
       updated_at = now()
 where 'audience_post' = any (lanes)
   and cardinality(array_remove(lanes, 'audience_post')) > 0;

create or replace function search_creators(
  p_tenant_id         uuid,
  p_order             text    default 'newest',
  p_lane              text    default null,
  p_platform          text    default null,
  p_niches            text[]  default null,
  p_max_price_cents   integer default null,
  p_max_delivery_days integer default null,
  p_country_code      text    default null,
  p_city              text    default null,
  p_limit             integer default 50,
  p_offset            integer default 0
)
returns table (
  human_member_id       uuid,
  slug                  text,
  display_name          text,
  lanes                 text[],
  niches                text[],
  platforms             text[],
  city                  text,
  country_code          text,
  bookable              boolean,
  intro_video_path      text,
  self_reported_metrics jsonb,
  from_price_cents      integer,
  joined_at             timestamptz,
  order_applied         text,
  handles               jsonb,
  packages              jsonb
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_tenant_id is null then
    raise exception 'search_creators: tenant_id required' using errcode = '22023';
  end if;
  if p_order is null or p_order not in ('newest', 'a_to_z') then
    raise exception 'search_creators: order must be newest or a_to_z' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (select 1 from tenant_users tu
                   where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  return query
  select
    m.id,
    m.slug,
    m.display_name,
    array_remove(coalesce(m.lanes, '{}'::text[]), 'audience_post'),
    coalesce(m.skills, '{}'::text[]),
    coalesce((select array_agg(distinct h.platform order by h.platform)
                from human_member_handles h where h.human_member_id = m.id), '{}'::text[]),
    m.city,
    m.country_code,
    creator_payout_country_supported(m.country_code),
    m.intro_video_path,
    coalesce(m.public_metrics, '{}'::jsonb),
    (select min(p.price_cents)::integer from creator_packages p
      where p.human_member_id = m.id and p.active and p.kind = 'ugc_video'),
    m.created_at,
    p_order,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', h.platform, 'handle', h.handle, 'followers', h.followers)
             order by h.platform, h.handle)
        from human_member_handles h where h.human_member_id = m.id), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'kind', p.kind, 'title', p.title, 'description', p.description,
               'price_cents', p.price_cents, 'currency', p.currency, 'delivery_days', p.delivery_days,
               'video_count', p.video_count, 'video_length_seconds', p.video_length_seconds,
               'ad_rights_days', p.ad_rights_days, 'addons', p.addons)
             order by p.created_at, p.id)
        from creator_packages p
       where p.human_member_id = m.id and p.active and p.kind = 'ugc_video'), '[]'::jsonb)
  from human_members m
  where m.vetting_state = 'approved'
    and creator_payout_country_supported(m.country_code)
    and (p_lane is null or (p_lane = 'ugc_video' and p_lane = any (coalesce(m.lanes, '{}'::text[]))))
    and (p_platform is null or exists (select 1 from human_member_handles h
                                       where h.human_member_id = m.id and h.platform = p_platform))
    and (p_niches is null or cardinality(p_niches) = 0 or m.skills && p_niches)
    and (p_max_price_cents is null or exists (
          select 1 from creator_packages p
           where p.human_member_id = m.id and p.active and p.kind = 'ugc_video'
             and p.price_cents <= p_max_price_cents))
    and (p_max_delivery_days is null or exists (
          select 1 from creator_packages p
           where p.human_member_id = m.id and p.active and p.kind = 'ugc_video'
             and p.delivery_days <= p_max_delivery_days))
    and (p_country_code is null or m.country_code = upper(p_country_code))
    and (p_city is null or lower(m.city) = lower(btrim(p_city)))
  order by
    case when p_order = 'newest' then m.created_at end desc,
    case when p_order = 'a_to_z' then lower(m.display_name) end asc,
    m.id asc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

revoke execute on function search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function search_creators(uuid, text, text, text, text[], integer, integer, text, text, integer, integer)
  to service_role;

commit;
