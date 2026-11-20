
begin;

alter table if exists bench_members        rename to human_members;
alter table if exists bench_member_handles rename to human_member_handles;
alter table if exists bench_member_pii     rename to human_member_pii;

alter index if exists bench_member_handles_member_idx
  rename to human_member_handles_member_idx;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='brief_applications' and column_name='bench_member_id') then
    alter table brief_applications rename column bench_member_id to human_member_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_name='engagements' and column_name='bench_member_id') then
    alter table engagements rename column bench_member_id to human_member_id;
  end if;
end $$;

commit;

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
  order by
    case
      when p_skills is null or cardinality(p_skills) = 0 then 0
      else cardinality(array(select unnest(m.skills) intersect select unnest(p_skills)))
    end desc,
    m.rate_usd asc nulls last,
    m.created_at asc
  limit 50;
end $$;

create or replace function human_resolve_brief(
  p_brief_kind text,
  p_brief_id   uuid
) returns table (tenant_id uuid, utm_campaign text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_brief_kind = 'creative' then
    return query
      select b.tenant_id, b.utm_campaign, b.status
        from creator_briefs b
       where b.id = p_brief_id;
  end if;
  return;
end $$;

create or replace function human_resolve_application(
  p_application_id uuid
) returns table (
  tenant_id       uuid,
  brief_kind      text,
  brief_id        uuid,
  human_member_id uuid,
  status          text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select a.tenant_id, a.brief_kind, a.brief_id, a.human_member_id, a.status
      from brief_applications a
     where a.id = p_application_id;
end $$;

revoke execute on function search_human_members(uuid, text, text[], numeric) from public, anon, authenticated;
grant  execute on function search_human_members(uuid, text, text[], numeric) to service_role;
revoke execute on function human_resolve_brief(text, uuid) from public, anon, authenticated;
grant  execute on function human_resolve_brief(text, uuid) to service_role;
revoke execute on function human_resolve_application(uuid) from public, anon, authenticated;
grant  execute on function human_resolve_application(uuid) to service_role;

drop function if exists search_bench_members(uuid, text, text[], numeric);
drop function if exists bench_resolve_brief(text, uuid);
drop function if exists bench_resolve_application(uuid);

update decision_classes
   set slug = 'human.application_review'
 where slug = 'bench.application_review'
   and not exists (select 1 from decision_classes where slug = 'human.application_review');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('human-proof','human-proof',false,10485760,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

commit;
