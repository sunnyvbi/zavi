
begin;

create or replace function public.claim_extension_op(
  p_tenant_id uuid,
  p_user_id uuid,
  p_session_id uuid
) returns setof public.extension_browser_ops
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_row public.extension_browser_ops;
begin
  if p_tenant_id is null or p_user_id is null or p_session_id is null then
    raise exception 'tenant_id, user_id and session_id are required' using errcode = '22023';
  end if;

  perform 1 from public.extension_panel_sessions s
    where s.id = p_session_id
      and s.tenant_id = p_tenant_id
      and s.user_id = p_user_id
      and s.ended_at is null
      and s.last_seen_at > now() - interval '30 seconds'
    for update;
  if not found then
    return;
  end if;

  if exists (
    select 1 from public.system_config sc
    where (sc.blob ->> 'extension_browser_control_enabled') = 'false'
  ) then
    return;
  end if;

  perform 1 from public.extension_consent c
    where c.tenant_id = p_tenant_id
      and c.user_id = p_user_id
      and c.revoked_at is null
    for share;
  if not found then
    return;
  end if;

  update public.extension_browser_ops o
     set status = case when o.is_write then 'unknown' else 'lease_expired' end
   where o.tenant_id = p_tenant_id
     and o.user_id = p_user_id
     and o.panel_session_id = p_session_id
     and o.status = 'delivered'
     and o.lease_until <= now();

  select o.id into v_id
    from public.extension_browser_ops o
   where o.tenant_id = p_tenant_id
     and o.user_id = p_user_id
     and o.panel_session_id = p_session_id
     and o.status in ('queued', 'lease_expired')
     and o.expires_at > now()
   order by o.created_at, o.seq
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  update public.extension_browser_ops o
     set status = 'delivered',
         execution_token = gen_random_uuid(),
         lease_until = now() + interval '15 seconds'
   where o.id = v_id
  returning o.* into v_row;

  return next v_row;
  return;
end $$;

revoke all on function public.claim_extension_op(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_extension_op(uuid, uuid, uuid) to service_role;

commit;
