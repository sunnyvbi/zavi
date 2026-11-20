
begin;

create table public.ad_pending_tests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  channel_slug     text not null check (channel_slug in ('tiktok_ads', 'reddit_ads')),
  status           text not null default 'pending' check (status in ('pending', 'claimed', 'closed')),
  daily_budget_usd numeric(12,2) not null check (daily_budget_usd > 0),
  hold_usd         numeric(12,2) not null check (hold_usd >= 0),
  proposal         jsonb not null,
  action_id        uuid,
  hold_idem_key    text,
  closed_reason    text,
  revision         integer not null default 1,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  updated_at       timestamptz not null default now(),
  unique (tenant_id, channel_slug),
  check (status <> 'claimed' or (action_id is not null and hold_idem_key is not null))
);

alter table public.ad_pending_tests enable row level security;
revoke all on public.ad_pending_tests from anon, authenticated;
grant all on public.ad_pending_tests to service_role;

create or replace function public.release_pending_test_hold(
  p_tenant_id         uuid,
  p_idem_key          text,
  p_channel_action_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_res       ad_budget_reservations%rowtype;
  v_exec      text;
  v_code      text;
  v_class     text;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' or p_channel_action_id is null then
    raise exception 'release_pending_test_hold: tenant, idem_key and channel action are required';
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_res from ad_budget_reservations
   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id
   for update;
  if v_res.status <> 'reserved' then
    return jsonb_build_object('status', v_res.status);
  end if;
  if v_res.channel_action_id is distinct from p_channel_action_id then
    return jsonb_build_object('status', 'not_found');
  end if;

  select exec_status, exec_result->>'code', exec_class into v_exec, v_code, v_class
    from channel_actions
   where id = p_channel_action_id and tenant_id = p_tenant_id
   for update;
  if found and (
       v_exec in ('queued', 'dispatching', 'executed')
       or (v_exec = 'failed' and coalesce(v_code, '') = 'exec_outcome_unknown')
       or (v_exec = 'failed' and coalesce(v_code, '') = 'exec_partial' and v_class is distinct from 'tiktok_ads.create_launch')
     ) then
    return jsonb_build_object('status', 'busy');
  end if;

  update ad_budget_reservations
     set status = 'released', reason = 'pending_test_released', released_on = null,
         pause_due = false, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'released');
end $$;

revoke all on function public.release_pending_test_hold(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.release_pending_test_hold(uuid, text, uuid) to service_role;

commit;
