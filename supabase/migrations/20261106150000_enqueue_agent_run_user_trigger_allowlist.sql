
create or replace function enqueue_agent_run(
  p_tenant_id uuid,
  p_agent_slug text,
  p_agent_hash text,
  p_trigger text,
  p_payload jsonb,
  p_cron_dedupe_key text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_id  uuid;
  v_enforce boolean;
  v_status  text;
  v_gf      boolean;
  v_plan    text;
  v_allow   int;
  v_iu      int;
  v_ia      int;
  v_pb      int;
  v_source  text;
begin
  if auth.uid() is not null and not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  if auth.uid() is not null and p_trigger not in ('chat', 'manual') then
    raise exception 'trigger % is server-only', p_trigger using errcode = '42501';
  end if;

  if auth.uid() is not null and p_cron_dedupe_key like 'cgo:draft:%:setup%' then
    raise exception 'reserved dedupe key' using errcode = '42501';
  end if;

  if p_trigger = 'manual' then
    if auth.uid() is null then
      raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not exists (
      select 1 from tenant_users
      where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  v_enforce := (p_agent_slug = 'engineer')
    and not _credits_enforced(p_tenant_id)
    and coalesce((select (blob->>'build_credits_enforced')::boolean
                  from system_config where id = 1), false);
  if v_enforce then
    if auth.uid() is not null and not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;

    select status, grandfathered, plan into v_status, v_gf, v_plan
    from tenant_subscriptions where tenant_id = p_tenant_id;
    if v_status is not null and v_status in ('canceled', 'incomplete') then
      raise exception 'build_credits_locked' using errcode = 'P0001';
    end if;

    v_allow := case
      when v_gf then 250
      when v_plan = 'solo' then 50
      when v_plan = 'team' then 250
      when v_plan = 'full' then 1000
      when v_plan = 'enterprise' then 1000000
      else 5
    end;

    insert into tenant_build_credits (tenant_id, period_start, period_end, included_allowance)
    values (p_tenant_id,
            date_trunc('month', current_date)::date,
            (date_trunc('month', current_date) + interval '1 month')::date,
            v_allow)
    on conflict (tenant_id) do nothing;

    perform 1 from tenant_build_credits where tenant_id = p_tenant_id for update;
    update tenant_build_credits
       set period_start       = case when current_date >= period_end
                                     then date_trunc('month', current_date)::date
                                     else period_start end,
           period_end         = case when current_date >= period_end
                                     then (date_trunc('month', current_date) + interval '1 month')::date
                                     else period_end end,
           included_used      = case when current_date >= period_end then 0 else included_used end,
           included_allowance = v_allow,
           updated_at         = now()
     where tenant_id = p_tenant_id;

    select included_used, included_allowance, purchased_balance
      into v_iu, v_ia, v_pb
    from tenant_build_credits where tenant_id = p_tenant_id;
    if v_iu < v_ia then
      update tenant_build_credits set included_used = included_used + 1, updated_at = now()
      where tenant_id = p_tenant_id;
      v_source := 'included';
    elsif v_pb > 0 then
      update tenant_build_credits set purchased_balance = purchased_balance - 1, updated_at = now()
      where tenant_id = p_tenant_id;
      v_source := 'purchased';
    else
      raise exception 'insufficient_build_credits' using errcode = 'P0001';
    end if;
  end if;

  if p_cron_dedupe_key is null then
    insert into agent_runs (
      tenant_id, agent_slug, agent_definition_hash, trigger,
      status, enqueued_by, cron_dedupe_key, payload
    )
    values (
      p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
      'queued', auth.uid(), null, p_payload
    )
    returning id into v_run_id;
  else
    insert into agent_runs (
      tenant_id, agent_slug, agent_definition_hash, trigger,
      status, enqueued_by, cron_dedupe_key, payload
    )
    values (
      p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
      'queued', auth.uid(), p_cron_dedupe_key, p_payload
    )
    on conflict (cron_dedupe_key) where cron_dedupe_key is not null do nothing
    returning id into v_run_id;
  end if;

  if v_enforce then
    if v_run_id is null then
      raise exception 'enqueue_deduped_no_run' using errcode = 'P0001';
    end if;
    insert into tenant_build_credit_ledger (run_id, tenant_id, agent_slug, amount, source, period_start)
    select v_run_id, p_tenant_id, p_agent_slug, 1, v_source, period_start
    from tenant_build_credits where tenant_id = p_tenant_id;
  end if;

  return v_run_id;
end $$;

revoke all on function enqueue_agent_run(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to authenticated, service_role;
