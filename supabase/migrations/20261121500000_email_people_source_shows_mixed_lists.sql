begin;

create or replace function public.email_contacts_people(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_search    text default null,
  p_list_id   uuid default null,
  p_limit     int default 50,
  p_offset    int default 0
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_role   text;
  v_member boolean;
  v_q      text := nullif(btrim(left(coalesce(p_search, ''), 200)), '');
  v_like   text;
  v_limit  int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total  int;
  v_rows   jsonb;
  v_counts jsonb;
begin
  if p_tenant_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select tu.role into v_role from public.tenant_users tu
   where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id limit 1;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  v_member := v_role not in ('owner', 'admin');
  if v_q is not null then
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with held as (
    select distinct m.contact_id, l.id as list_id, l.name as list_name, v.source_kind,
           case when v.source_kind = 'database' and v.source_ref ->> 'mixed' = 'database_and_csv'
                then 'database_and_csv' else v.source_kind end as source,
           v.created_at as version_created_at
      from public.email_lists l
      join public.email_list_versions v on v.tenant_id = l.tenant_id and v.list_id = l.id
      join public.email_list_version_contacts m on m.tenant_id = v.tenant_id and m.version_id = v.id
     where l.tenant_id = p_tenant_id and l.archived_at is null
       and not (v_member and exists (
             select 1 from public.email_list_versions dv
              where dv.tenant_id = l.tenant_id and dv.list_id = l.id and dv.source_kind = 'database'
                and (dv.id = l.active_version_id
                     or dv.id = (select v3.id from public.email_list_versions v3
                                  where v3.tenant_id = l.tenant_id and v3.list_id = l.id
                                  order by v3.created_at desc, v3.id desc limit 1))))
       and (v.id = l.active_version_id
            or v.id = (select v2.id from public.email_list_versions v2
                        where v2.tenant_id = l.tenant_id and v2.list_id = l.id
                        order by v2.created_at desc, v2.id desc limit 1))
  ), per as (
    select x.contact_id,
           bool_or(x.source_kind = 'database') as has_db,
           (array_agg(x.source order by x.version_created_at, x.list_id))[1] as source,
           jsonb_agg(distinct jsonb_build_object('id', x.list_id, 'name', x.list_name)) as lists,
           bool_or(x.list_id = p_list_id) as in_list
      from held x
     group by x.contact_id
  ), people as (
    select c.id,
           case when v_member and h.has_db then public._email_mask_address(c.email_norm) else c.email_norm end as email,
           (v_member and h.has_db) as masked,
           c.display_name as name,
           h.lists,
           coalesce(
             case when s.email is not null then
               case s.reason
                 when 'unsubscribe' then 'unsubscribed'
                 when 'bounce' then 'bounced'
                 when 'complaint' then 'complained'
                 when 'erased' then 'erased'
                 else 'suppressed' end end,
             case when u.recipient is not null then 'unsubscribed' end,
             case when x.recipient is not null then
               case x.reason
                 when 'bounce' then 'bounced'
                 when 'complaint' then 'complained'
                 else 'suppressed' end end,
             'ok') as status,
           h.source,
           c.created_at as added_at,
           coalesce(h.in_list, false) as in_list
      from public.email_contacts c
      join per h on h.contact_id = c.id
      left join public.email_suppression s
        on s.tenant_id = p_tenant_id and s.email = lower(trim(c.email_norm))
      left join public.comms_unsubscribes u
        on u.tenant_id = p_tenant_id and u.channel = 'email' and u.recipient = lower(trim(c.email_norm))
      left join public.comms_suppressions x
        on x.tenant_id = p_tenant_id and x.channel = 'email' and x.recipient = lower(trim(c.email_norm))
     where c.tenant_id = p_tenant_id and c.erased_at is null and c.email_norm is not null
  ), hit as (
    select p.* from people p
     where (p_list_id is null or p.in_list)
       and (v_like is null
            or lower(coalesce(p.name, '')) like v_like escape '\'
            or (not p.masked and p.email like v_like escape '\'))
  )
  select
    (select count(*) from hit),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'id', y.id, 'email', y.email, 'masked', y.masked, 'name', y.name, 'lists', y.lists,
              'status', y.status, 'source', y.source, 'added_at', y.added_at)
              order by y.added_at desc, y.id), '[]'::jsonb)
       from (select * from hit order by added_at desc, id limit v_limit offset v_offset) y),
    case when v_q is null and v_offset = 0 then
      (select jsonb_build_object(
                'contacts', count(*),
                'lists', (select count(*) from public.email_lists l where l.tenant_id = p_tenant_id and l.archived_at is null),
                'unsubscribed', count(*) filter (where p.status = 'unsubscribed'),
                'bounced', count(*) filter (where p.status = 'bounced'))
         from people p)
    end
    into v_total, v_rows, v_counts;

  return jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows, 'counts', v_counts, 'masked', v_member);
end $$;
revoke all on function public.email_contacts_people(uuid, uuid, text, uuid, int, int) from public, anon, authenticated;
grant execute on function public.email_contacts_people(uuid, uuid, text, uuid, int, int) to service_role;

commit;
