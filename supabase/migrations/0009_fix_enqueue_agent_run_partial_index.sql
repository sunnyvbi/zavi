
create or replace function enqueue_agent_run(
  p_tenant_id uuid, p_agent_slug text, p_agent_hash text, p_trigger text,
  p_payload jsonb, p_cron_dedupe_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_run_id uuid;
begin
  if p_trigger = 'manual' then
    if not exists (select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if p_cron_dedupe_key is null then
    insert into agent_runs (tenant_id, agent_slug, agent_definition_hash, trigger,
                            status, enqueued_by, cron_dedupe_key)
    values (p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
            'queued', auth.uid(), null)
    returning id into v_run_id;
  else
    insert into agent_runs (tenant_id, agent_slug, agent_definition_hash, trigger,
                            status, enqueued_by, cron_dedupe_key)
    values (p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
            'queued', auth.uid(), p_cron_dedupe_key)
    on conflict (cron_dedupe_key) do nothing
    returning id into v_run_id;
  end if;

  return v_run_id;
end $$;
revoke all on function enqueue_agent_run(uuid, text, text, text, jsonb, text) from public;
grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to authenticated;
