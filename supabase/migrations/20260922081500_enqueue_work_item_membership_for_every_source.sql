
create or replace function enqueue_work_item(
  p_tenant_id   uuid,
  p_agent_slug  text,
  p_source      text,
  p_payload     jsonb default null,
  p_dedupe_key  text default null,
  p_priority    int  default 0,
  p_next_run_at timestamptz default now(),
  p_risk_tier   text default null,
  p_work_type   text default null,
  p_lane        text default 'e2b'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_lane text := coalesce(p_lane, 'e2b');
begin
  if auth.role() is distinct from 'service_role' then
    if p_source not in ('chat', 'manual') then
      raise exception 'source % may only be enqueued by the server', p_source
        using errcode = '42501';
    end if;
    if not exists (select 1 from tenant_users
                   where user_id = auth.uid() and tenant_id = p_tenant_id) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
    v_lane := 'e2b';
  end if;

  insert into agent_work_items (tenant_id, agent_slug, source, payload,
                               dedupe_key, priority, next_run_at, risk_tier,
                               work_type, lane)
  values (p_tenant_id, p_agent_slug, p_source, p_payload,
          p_dedupe_key, p_priority, p_next_run_at, p_risk_tier,
          p_work_type, v_lane)
  on conflict (tenant_id, agent_slug, dedupe_key)
    where dedupe_key is not null and status in ('pending', 'leased')
    do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id from agent_work_items
    where tenant_id = p_tenant_id and agent_slug = p_agent_slug
      and dedupe_key = p_dedupe_key and status in ('pending', 'leased')
    order by created_at desc limit 1;
  end if;

  return v_id;
end $$;

revoke all on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text, text, text) from public;
grant execute on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text, text, text) to authenticated, service_role;

revoke all on function ingest_and_enqueue_work(
  uuid, text, text, text, jsonb, text, text, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function ingest_and_enqueue_work(
  uuid, text, text, text, jsonb, text, text, jsonb, text, text, text
) to service_role;
