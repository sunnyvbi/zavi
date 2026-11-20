begin;

create or replace function public.email_list_import_version(
  p_tenant_id   uuid,
  p_list_id     uuid,
  p_list_name   text,
  p_source_kind text,
  p_source_ref  jsonb,
  p_emails      text[],
  p_created_by  uuid,
  p_names       text[] default null,
  p_base_version_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_norm       text[];
  v_list_id    uuid;
  v_version_id uuid;
  v_count      int;
  v_blocked    int;
  v_latest     uuid;
  v_new        int;
  v_new_blocked int;
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
  perform pg_advisory_xact_lock(hashtextextended('email_contacts:' || p_tenant_id::text, 0));
  select coalesce(array_agg(distinct lower(trim(e))), '{}'::text[]) into v_norm
    from unnest(p_emails) as e
   where e is not null and length(trim(e)) > 0
     and not exists (select 1 from public.email_suppression s
                      where s.tenant_id = p_tenant_id and s.email = lower(trim(e)) and s.reason = 'erased');
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
    if p_base_version_id is not null then
      select v.id into v_latest from public.email_list_versions v
       where v.tenant_id = p_tenant_id and v.list_id = v_list_id
       order by v.created_at desc, v.id desc limit 1;
      if v_latest is distinct from p_base_version_id then
        return jsonb_build_object('ok', false, 'reason', 'list_changed');
      end if;
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

  select count(*), count(*) filter (where public.email_bulk_block_reason(p_tenant_id, e) is not null)
    into v_new, v_new_blocked
    from unnest(v_norm) as e
   where p_base_version_id is null or not exists (
     select 1 from public.email_list_version_contacts m
       join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
      where m.tenant_id = p_tenant_id and m.version_id = p_base_version_id
        and c.erased_at is null and c.email_norm = e);

  return jsonb_build_object(
    'ok', true, 'list_id', v_list_id, 'version_id', v_version_id,
    'contact_count', v_count, 'already_blocked', v_blocked,
    'new_count', v_new, 'new_blocked', v_new_blocked);
end $$;
revoke all on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid, text[], uuid) to service_role;

create or replace function public.email_contact_erase(p_tenant_id uuid, p_contact_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_email text;
begin
  if p_tenant_id is null or p_contact_id is null then
    raise exception 'email_contact_erase: null argument' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_contacts:' || p_tenant_id::text, 0));
  select c.email_norm into v_email from public.email_contacts c
   where c.id = p_contact_id and c.tenant_id = p_tenant_id and c.erased_at is null
   for update;
  if v_email is null then
    return false;
  end if;
  insert into public.email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'erased')
  on conflict (tenant_id, email) do update
    set reason = case
                   when public.email_suppression_reason_rank(excluded.reason) > public.email_suppression_reason_rank(email_suppression.reason)
                     then excluded.reason
                   else email_suppression.reason
                 end;
  update public.email_bulk_send_recipients r
     set status = 'skipped', skip_reason = 'erased', stamped_at = now()
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id and r.status in ('pending', 'sending');
  update public.email_bulk_send_recipients r
     set email_at_send = null
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id;
  delete from public.email_unsub_token t
   where t.tenant_id = p_tenant_id and t.email = lower(v_email);
  update public.email_contacts c
     set erased_at = now(), email_norm = null, display_name = null, updated_at = now()
   where c.id = p_contact_id and c.tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function public.email_contact_erase(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_contact_erase(uuid, uuid) to service_role;

commit;
