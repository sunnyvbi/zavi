begin;

create or replace function claim_channel_run(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_request_id   text,
  p_estimate     int,
  p_join_lane    text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key      text := left(nullif(btrim(p_request_id), ''), 200);
  v_est      int  := greatest(coalesce(p_estimate, 0), 0);
  v_lane     text := left(nullif(btrim(p_join_lane), ''), 64);
  v_claim_id uuid;
  v_run_id   uuid;
  v_joined   uuid;
  v_owner    uuid;
  v_pending  int;
  v_at       timestamptz;
begin
  if p_tenant_id is null then
    raise exception 'claim_channel_run: tenant_id required' using errcode = 'P0001';
  end if;
  if p_channel_slug is null or length(btrim(p_channel_slug)) = 0 then
    raise exception 'claim_channel_run: channel_slug required' using errcode = 'P0001';
  end if;
  if v_key is null or char_length(v_key) < 8 then
    raise exception 'claim_channel_run: request_id must be 8-200 chars' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('channel_run_claim:' || p_tenant_id::text, 0));

  select c.id, coalesce(c.run_id, p.run_id), c.joined_claim_id, coalesce(p.claimed_at, c.claimed_at), coalesce(p.id, c.id)
    into v_claim_id, v_run_id, v_joined, v_at, v_owner
    from channel_run_claims c
    left join channel_run_claims p
      on p.id = c.joined_claim_id and p.tenant_id = p_tenant_id
   where c.tenant_id = p_tenant_id
     and c.channel_slug = p_channel_slug
     and c.request_id = v_key;
  if v_claim_id is not null and v_run_id is null and v_at <= now() - channel_claim_stale_after() then
    select r.id into v_run_id
      from agent_runs r
     where r.tenant_id = p_tenant_id
       and r.payload->>'channel_claim_id' = v_owner::text
     order by r.enqueued_at
     limit 1;
    if v_run_id is null then
      select r.id into v_run_id
        from agent_runs r
       where r.tenant_id = p_tenant_id
         and r.payload->>'channel_slug' = p_channel_slug
         and not (r.payload ? 'channel_claim_id')
         and r.enqueued_at >= v_at
         and r.enqueued_at <= v_at + channel_claim_stale_after()
         and not exists (
               select 1 from channel_run_claims o
                where o.tenant_id = p_tenant_id
                  and o.run_id = r.id)
       order by r.enqueued_at
       limit 1;
    end if;
    if v_run_id is not null then
      update channel_run_claims
         set run_id = coalesce(run_id, v_run_id)
       where tenant_id = p_tenant_id
         and id in (v_owner, v_claim_id);
      return jsonb_build_object(
        'ok', true, 'duplicate', true, 'joined', v_joined is not null,
        'claim_id', v_claim_id, 'run_id', v_run_id);
    end if;
    delete from channel_run_claims
     where id = v_claim_id
       and tenant_id = p_tenant_id
       and run_id is null;
    v_claim_id := null;
    v_joined := null;
  end if;
  if v_claim_id is not null then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'joined', v_joined is not null,
      'claim_id', v_claim_id, 'run_id', v_run_id);
  end if;

  if v_lane is not null then
    select c.id, c.run_id into v_joined, v_run_id
      from channel_run_claims c
      left join agent_runs r on r.id = c.run_id and r.tenant_id = p_tenant_id
     where c.tenant_id = p_tenant_id
       and c.channel_slug = p_channel_slug
       and c.join_lane = v_lane
       and c.joined_claim_id is null
       and c.claimed_at > now() - channel_run_join_window()
       and (
             (c.run_id is null and c.claimed_at > now() - channel_claim_stale_after())
          or (r.id is not null
              and r.status in ('queued', 'running'))
           )
     order by c.claimed_at desc
     limit 1;

    if v_joined is not null then
      insert into channel_run_claims
        (tenant_id, channel_slug, request_id, estimate, run_id, settled_at, join_lane, joined_claim_id)
      values
        (p_tenant_id, p_channel_slug, v_key, 0, v_run_id, now(), v_lane, v_joined)
      returning id into v_claim_id;
      return jsonb_build_object(
        'ok', true, 'duplicate', true, 'joined', true,
        'claim_id', v_claim_id, 'run_id', v_run_id);
    end if;
  end if;

  select coalesce(sum(estimate), 0)::int into v_pending
    from channel_run_claims
   where tenant_id = p_tenant_id
     and settled_at is null
     and claimed_at > now() - channel_claim_stale_after();

  if not channel_budget_allows(p_tenant_id, v_est + v_pending) then
    return jsonb_build_object(
      'ok', false, 'reason', 'cap_reached',
      'spent_30d', channel_credits_30d(p_tenant_id) + v_pending);
  end if;

  insert into channel_run_claims (tenant_id, channel_slug, request_id, estimate, join_lane)
  values (p_tenant_id, p_channel_slug, v_key, v_est, v_lane)
  on conflict (tenant_id, channel_slug, request_id) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    select id, run_id into v_claim_id, v_run_id
      from channel_run_claims
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and request_id = v_key;
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'claim_id', v_claim_id, 'run_id', v_run_id);
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'claim_id', v_claim_id);
end $$;

revoke all on function claim_channel_run(uuid, text, text, int, text) from public, anon, authenticated;
grant execute on function claim_channel_run(uuid, text, text, int, text) to service_role;

commit;
