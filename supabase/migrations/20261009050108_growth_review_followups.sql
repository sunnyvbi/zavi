begin;

create function public.record_ad_budget_partial_actual(p_tenant_id uuid, p_budget_id uuid, p_actual_usd numeric, p_month date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_chatgpt_known numeric;
begin
  if p_actual_usd is null or not (p_actual_usd >= 0 and p_actual_usd < 1000000000) then
    raise exception 'invalid partial actual';
  end if;
  select coalesce(sum(amount_usd), 0) into v_chatgpt_known from ad_spend_daily
   where tenant_id = p_tenant_id and platform = 'chatgpt' and source = 'api'
     and spend_date >= p_month and spend_date < (p_month + interval '1 month')::date;
  update ad_budgets set spent_usd = greatest(spent_usd, ceil((p_actual_usd + v_chatgpt_known) * 100) / 100), updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
     and month_start = p_month and month_start = date_trunc('month', _ad_budget_today())::date;
  return record_ad_budget_actual(p_tenant_id, p_budget_id, null, p_month);
end $$;

create function public.note_chatgpt_workspace_hold(p_tenant_id uuid, p_idem_key text, p_target jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_budget_id uuid;
begin
  if p_target is null or jsonb_typeof(p_target) <> 'object' or p_target->>'kind' is distinct from 'chatgpt_workspace' then return false; end if;
  select budget_id into v_budget_id from ad_budget_reservations where tenant_id = p_tenant_id and idem_key = p_idem_key order by created_at desc limit 1;
  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  update ad_budget_reservations set provider_ref = p_target, updated_at = now()
   where tenant_id = p_tenant_id and budget_id = v_budget_id and idem_key = p_idem_key
     and platform = 'chatgpt' and op in ('resume', 'raise') and status = 'reserved'
     and object_id = p_target->>'campaign_id' and decision_id is null and channel_action_id is null
     and (provider_ref is null or provider_ref = p_target);
  if found then return true; end if;
  return exists (select 1 from ad_budget_reservations where tenant_id = p_tenant_id and budget_id = v_budget_id
    and idem_key = p_idem_key and platform = 'chatgpt' and status = 'committed' and provider_ref = p_target);
end $$;

create function public.revoke_chatgpt_autopilot(p_tenant_id uuid, p_actor_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then return false; end if;
  if not set_channel_autorun(p_tenant_id, 'chatgpt_ads', false) then return false; end if;
  update tenant_channels set chatgpt_autopilot_consent_at = null where tenant_id = p_tenant_id and channel_slug = 'chatgpt_ads' and autorun = false;
  return found;
end $$;
revoke all on function public.record_ad_budget_partial_actual(uuid,uuid,numeric,date) from public,anon,authenticated;
revoke all on function public.note_chatgpt_workspace_hold(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.revoke_chatgpt_autopilot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_ad_budget_partial_actual(uuid,uuid,numeric,date) to service_role;
grant execute on function public.note_chatgpt_workspace_hold(uuid,text,jsonb) to service_role;
grant execute on function public.revoke_chatgpt_autopilot(uuid,uuid) to service_role;
commit;
