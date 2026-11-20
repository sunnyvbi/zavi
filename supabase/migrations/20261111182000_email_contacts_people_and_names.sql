begin;

create or replace function public._email_contact_name(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(btrim(left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[\x01-\x1f\x7f-\x9f  ]', ' ', 'g'), '\s+', ' ', 'g')), 200)), '');
$$;
revoke all on function public._email_contact_name(text) from public, anon, authenticated;
grant execute on function public._email_contact_name(text) to service_role;

create or replace function public._email_mask_address(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then null
              when strpos(p, '@') < 2 then '•••'
              else left(p, 1) || '•••' || substring(p from '(@[^@]*)$') end;
$$;
revoke all on function public._email_mask_address(text) from public, anon, authenticated;
grant execute on function public._email_mask_address(text) to service_role;

drop function if exists public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid);

create or replace function public.email_list_import_version(
  p_tenant_id   uuid,
  p_list_id     uuid,
  p_list_name   text,
  p_source_kind text,
  p_source_ref  jsonb,
  p_emails      text[],
  p_created_by  uuid,
  p_names       text[] default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_norm       text[];
  v_list_id    uuid;
  v_version_id uuid;
  v_count      int;
  v_blocked    int;
begin
  if p_tenant_id is null or p_created_by is null or p_emails is null then
    raise exception 'email_list_import_version: null argument' using errcode = '22023';
  end if;
  if p_source_kind not in ('csv', 'database') then
    raise exception 'email_list_import_version: invalid source' using errcode = '22023';
  end if;
  if p_names is not null and coalesce(array_length(p_names, 1), 0) <> coalesce(array_length(p_emails, 1), 0) then
    raise exception 'email_list_import_version: names do not line up with addresses' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(trim(e))), '{}'::text[]) into v_norm
    from unnest(p_emails) as e
   where e is not null and length(trim(e)) > 0;
  if coalesce(array_length(v_norm, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_addresses');
  end if;
  if array_length(v_norm, 1) > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if exists (select 1 from unnest(v_norm) as e where not public._email_import_address_ok(e)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_address');
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_created_by) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;

  if p_list_id is not null then
    select l.id into v_list_id from public.email_lists l
     where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null
     for update;
    if v_list_id is null then
      return jsonb_build_object('ok', false, 'reason', 'list_not_found');
    end if;
  else
    if p_list_name is null or length(trim(p_list_name)) not between 1 and 120 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_name');
    end if;
    if exists (select 1 from public.email_lists l
                where l.tenant_id = p_tenant_id and l.archived_at is null
                  and lower(trim(l.name)) = lower(trim(p_list_name))) then
      return jsonb_build_object('ok', false, 'reason', 'name_taken');
    end if;
    insert into public.email_lists (tenant_id, name, created_by)
    values (p_tenant_id, trim(p_list_name), p_created_by)
    returning id into v_list_id;
  end if;

  if p_names is null then
    insert into public.email_contacts (tenant_id, email_norm)
    select p_tenant_id, e from unnest(v_norm) as e
    on conflict (tenant_id, email_norm) do nothing;
  else
    insert into public.email_contacts (tenant_id, email_norm, display_name)
    with named as (
      select distinct on (lower(trim(u.email))) lower(trim(u.email)) as e, public._email_contact_name(u.name) as n
        from unnest(p_emails, p_names) with ordinality as u(email, name, ord)
       where u.email is not null and public._email_contact_name(u.name) is not null
       order by lower(trim(u.email)), u.ord
    )
    select p_tenant_id, x.e, named.n
      from unnest(v_norm) as x(e)
      left join named on named.e = x.e
    on conflict (tenant_id, email_norm) do update
       set display_name = excluded.display_name, updated_at = now()
     where public.email_contacts.display_name is null and excluded.display_name is not null;
  end if;

  v_count := array_length(v_norm, 1);
  insert into public.email_list_versions
    (tenant_id, list_id, source_kind, source_ref, contact_count, created_by)
  values
    (p_tenant_id, v_list_id, p_source_kind, coalesce(p_source_ref, '{}'::jsonb), v_count, p_created_by)
  returning id into v_version_id;

  insert into public.email_list_version_contacts (tenant_id, version_id, contact_id)
  select p_tenant_id, v_version_id, c.id
    from public.email_contacts c
   where c.tenant_id = p_tenant_id and c.email_norm = any (v_norm);

  select count(*) into v_blocked
    from unnest(v_norm) as e
   where public.email_bulk_block_reason(p_tenant_id, e) is not null;

  return jsonb_build_object(
    'ok', true, 'list_id', v_list_id, 'version_id', v_version_id,
    'contact_count', v_count, 'already_blocked', v_blocked);
end $$;
revoke all on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid, text[]) from public, anon, authenticated;
grant execute on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid, text[]) to service_role;

drop function if exists public.email_contacts_existing_count(uuid, text[]);

create or replace function public.email_contacts_existing_count(p_tenant_id uuid, p_user_id uuid, p_emails text[])
returns int
language sql stable security definer
set search_path = public, pg_temp as $$
  with caller as (
    select tu.role not in ('owner', 'admin') as member
      from public.tenant_users tu
     where p_tenant_id is not null and p_user_id is not null
       and tu.tenant_id = p_tenant_id and tu.user_id = p_user_id
     limit 1
  )
  select count(*)::int
    from public.email_contacts c, caller
   where c.tenant_id = p_tenant_id and c.erased_at is null
     and c.email_norm = any (
       select distinct lower(trim(e)) from unnest(coalesce(p_emails, '{}'::text[])) as e
        where e is not null and length(trim(e)) > 0)
     and (not caller.member or not exists (
       select 1
         from public.email_list_version_contacts m
         join public.email_list_versions v on v.tenant_id = m.tenant_id and v.id = m.version_id
         join public.email_lists l on l.tenant_id = v.tenant_id and l.id = v.list_id
        where m.tenant_id = p_tenant_id and m.contact_id = c.id
          and v.source_kind = 'database'));
$$;
revoke all on function public.email_contacts_existing_count(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.email_contacts_existing_count(uuid, uuid, text[]) to service_role;

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
    select distinct m.contact_id, l.id as list_id, l.name as list_name, v.source_kind, v.created_at as version_created_at
      from public.email_lists l
      join public.email_list_versions v on v.tenant_id = l.tenant_id and v.list_id = l.id
      join public.email_list_version_contacts m on m.tenant_id = v.tenant_id and m.version_id = v.id
     where l.tenant_id = p_tenant_id and l.archived_at is null
       and (v.id = l.active_version_id
            or v.id = (select v2.id from public.email_list_versions v2
                        where v2.tenant_id = l.tenant_id and v2.list_id = l.id
                        order by v2.created_at desc, v2.id desc limit 1))
  ), per as (
    select x.contact_id,
           bool_or(x.source_kind = 'database') as has_db,
           (array_agg(x.source_kind order by x.version_created_at, x.list_id))[1] as source,
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
