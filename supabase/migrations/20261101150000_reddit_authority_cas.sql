begin;

alter table public.reddit_ad_authority add column if not exists source_proposed_at timestamptz;
update public.reddit_ad_authority a
   set source_proposed_at = ca.proposed_at
  from public.channel_actions ca
 where ca.tenant_id = a.tenant_id and ca.id = a.action_id and a.source_proposed_at is null;
update public.reddit_ad_authority set source_proposed_at = updated_at where source_proposed_at is null;
alter table public.reddit_ad_authority alter column source_proposed_at set not null;

create or replace function public.save_reddit_ad_authority(
  p_tenant_id     uuid,
  p_ad_account_id text,
  p_limits        jsonb,
  p_action_id     uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_at timestamptz;
  v_n  integer;
begin
  if p_tenant_id is null or p_ad_account_id is null or btrim(p_ad_account_id) = '' or p_limits is null or p_action_id is null then
    raise exception 'save_reddit_ad_authority: tenant, ad account, limits and card are required';
  end if;
  select proposed_at into v_at
    from channel_actions
   where tenant_id = p_tenant_id
     and id = p_action_id
     and exec_class = 'reddit_ads.authorize_account'
     and exec_payload->>'ad_account_id' = p_ad_account_id;
  if v_at is null then
    return jsonb_build_object('ok', false, 'code', 'card_not_found');
  end if;
  insert into reddit_ad_authority as a (tenant_id, ad_account_id, limits, action_id, source_proposed_at, updated_at)
  values (p_tenant_id, p_ad_account_id, p_limits, p_action_id, v_at, now())
  on conflict (tenant_id, ad_account_id) do update
     set limits = excluded.limits,
         action_id = excluded.action_id,
         source_proposed_at = excluded.source_proposed_at,
         updated_at = now()
   where a.action_id = excluded.action_id
      or a.source_proposed_at < excluded.source_proposed_at;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'superseded');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.save_reddit_ad_authority(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_reddit_ad_authority(uuid, text, jsonb, uuid) to service_role;

commit;
