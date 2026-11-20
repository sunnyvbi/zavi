
begin;

create or replace function search_human_members(
  p_tenant_id  uuid,
  p_discipline text    default null,
  p_skills     text[]  default null,
  p_max_rate   numeric default null
)
returns table (
  human_member_id uuid,
  display_name    text,
  discipline      text,
  skills          text[],
  rate_usd        numeric,
  rate_unit       text,
  public_metrics  jsonb,
  handles         jsonb
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_tenant_id is null then
    raise exception 'search_human_members: tenant_id required' using errcode = '22023';
  end if;

  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  return query
  select
    m.id                                                   as human_member_id,
    m.display_name,
    m.discipline,
    m.skills,
    m.rate_usd,
    m.rate_unit,
    m.public_metrics,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object('platform', h.platform, 'handle', h.handle)
                 order by h.platform, h.handle
               )
        from human_member_handles h
        where h.human_member_id = m.id
      ),
      '[]'::jsonb
    )                                                      as handles
  from human_members m
  where
    m.vetting_state = 'approved'
    and (p_discipline is null or m.discipline = p_discipline)
    and (p_skills is null or cardinality(p_skills) = 0 or m.skills && p_skills)
    and (p_max_rate is null or (m.rate_usd is not null and m.rate_usd <= p_max_rate))
    and creator_payout_country_supported(m.country_code)
  order by
    m.created_at desc,
    m.id asc
  limit 50;
end $$;

revoke execute on function search_human_members(uuid, text, text[], numeric) from public, anon, authenticated;
grant  execute on function search_human_members(uuid, text, text[], numeric) to service_role;

commit;
