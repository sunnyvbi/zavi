begin;

create or replace function public.email_list_archived_summaries(p_tenant_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(s.item order by s.item->>'archived_at' desc, s.item->>'id'), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'archived_at', l.archived_at,
        'people', coalesce(a.contact_count, n.contact_count, 0),
        'from_database', coalesce(a.source_kind = 'database', false) or coalesce(n.source_kind = 'database', false)
      ) as item
        from public.email_lists l
        left join public.email_list_versions a
          on a.tenant_id = l.tenant_id and a.list_id = l.id and a.id = l.active_version_id
        left join lateral (
          select v.contact_count, v.source_kind
            from public.email_list_versions v
           where v.tenant_id = l.tenant_id and v.list_id = l.id
           order by v.created_at desc, v.id desc limit 1
        ) n on true
       where l.tenant_id = p_tenant_id and l.archived_at is not null
    ) s;
$$;
revoke all on function public.email_list_archived_summaries(uuid) from public, anon, authenticated;
grant execute on function public.email_list_archived_summaries(uuid) to service_role;

create or replace function public.email_list_unarchive(
  p_tenant_id uuid,
  p_list_id   uuid,
  p_user_id   uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_list public.email_lists%rowtype;
  v_stopped int;
begin
  if p_tenant_id is null or p_list_id is null or p_user_id is null then
    raise exception 'email_list_unarchive: null argument' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_users u
                  where u.tenant_id = p_tenant_id and u.user_id = p_user_id and u.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  select * into v_list from public.email_lists l
   where l.id = p_list_id and l.tenant_id = p_tenant_id
   for update;
  if v_list.id is null then
    return jsonb_build_object('ok', false, 'reason', 'list_not_found');
  end if;
  if v_list.archived_at is null then
    return jsonb_build_object('ok', true, 'unarchived', false, 'stopped_sends', 0);
  end if;
  begin
    update public.email_lists l set archived_at = null
     where l.id = p_list_id and l.tenant_id = p_tenant_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end;
  update public.email_bulk_sends s
     set status = 'held', hold_reason = 'list_archived', next_run_at = null
   where s.tenant_id = p_tenant_id and s.list_id = p_list_id
     and (s.status in ('sending', 'waiting_for_tomorrow')
          or (s.status = 'held' and s.hold_reason = 'email_paused'))
     and exists (select 1 from public.email_bulk_send_recipients r
                  where r.send_id = s.id and r.tenant_id = s.tenant_id and r.status = 'pending');
  select count(*) into v_stopped from public.email_bulk_sends s
   where s.tenant_id = p_tenant_id and s.list_id = p_list_id
     and s.status = 'held' and s.hold_reason = 'list_archived'
     and exists (select 1 from public.email_bulk_send_recipients r
                  where r.send_id = s.id and r.tenant_id = s.tenant_id and r.status = 'pending');
  return jsonb_build_object('ok', true, 'unarchived', true, 'stopped_sends', v_stopped);
end $$;
revoke all on function public.email_list_unarchive(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_list_unarchive(uuid, uuid, uuid) to service_role;

commit;
