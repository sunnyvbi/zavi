
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto) values
  ('bench.application_review', 'Review a contractor bench member''s application to one of your briefs (approve = engage them, paid out of band)', 'approval', null, true)
on conflict (slug) do update set
  description      = excluded.description,
  default_autonomy = 'approval',
  never_auto       = true;

create unique index if not exists engagements_application_id_key
  on engagements (application_id) where application_id is not null;

create or replace function bench_resolve_brief(
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

comment on function bench_resolve_brief(text, uuid) is
  'Resolve a polymorphic brief key to its OWNING tenant + attribution tag. The tenant_id a bench application is written under comes from HERE, never from the request body. Read-only, service_role only.';

revoke execute on function bench_resolve_brief(text, uuid) from public, anon, authenticated;
grant  execute on function bench_resolve_brief(text, uuid) to service_role;

create or replace function bench_resolve_application(
  p_application_id uuid
) returns table (
  tenant_id       uuid,
  brief_kind      text,
  brief_id        uuid,
  bench_member_id uuid,
  status          text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select a.tenant_id, a.brief_kind, a.brief_id, a.bench_member_id, a.status
      from brief_applications a
     where a.id = p_application_id;
end $$;

comment on function bench_resolve_application(uuid) is
  'Resolve an application id to its owning tenant + the bench member who wrote it, so the thread routes can authorize BOTH sides (tenant member, or that one bench member) without trusting a client-supplied tenant_id. Read-only, service_role only.';

revoke execute on function bench_resolve_application(uuid) from public, anon, authenticated;
grant  execute on function bench_resolve_application(uuid) to service_role;
