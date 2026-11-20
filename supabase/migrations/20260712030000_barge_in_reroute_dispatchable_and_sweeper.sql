
create or replace function reroute_undrained_steers(
  p_run_id    uuid,
  p_tenant_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_thread_id   text;
  v_agent_slug  text;
  v_agent_hash  text;
  v_user_id     uuid;
  v_ids         uuid[];
  v_leased      int;
  v_msg_id      uuid;
  v_new_run     uuid;
  v_thread_uuid uuid;
begin
  select r.payload->>'thread_id', r.agent_slug, r.agent_definition_hash, r.enqueued_by
    into v_thread_id, v_agent_slug, v_agent_hash, v_user_id
  from public.agent_runs r
  where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('rerouted', 0, 'reason', 'run_not_found');
  end if;

  select array_agg(s.id order by s.seq),
         count(*) filter (where s.status = 'leased')
    into v_ids, v_leased
  from (
    select s2.id, s2.seq, s2.status
    from public.agent_run_steers s2
    where s2.run_id = p_run_id
      and s2.tenant_id = p_tenant_id
      and s2.status in ('pending','leased')
    order by s2.seq
    for update
  ) s;

  if v_ids is null or array_length(v_ids, 1) = 0 then
    return jsonb_build_object('rerouted', 0, 'reason', 'nothing_undrained');
  end if;

  update public.agent_run_steers
     set status = 'rerouting'
   where id = any(v_ids);

  select t.id into v_thread_uuid
  from public.agent_threads t
  where t.id::text = v_thread_id
    and t.tenant_id = p_tenant_id
    and t.deleted_at is null;

  if v_thread_uuid is null then
    update public.agent_run_steers set status = 'dead' where id = any(v_ids);
    return jsonb_build_object('rerouted', 0, 'reason', 'thread_gone',
                              'dead', array_length(v_ids, 1));
  end if;

  select s.user_message_id into v_msg_id
  from public.agent_run_steers s
  where s.id = any(v_ids)
    and s.user_message_id is not null
  order by s.seq desc
  limit 1;

  if v_msg_id is null then
    update public.agent_run_steers set status = 'dead' where id = any(v_ids);
    return jsonb_build_object('rerouted', 0, 'reason', 'no_user_message',
                              'dead', array_length(v_ids, 1));
  end if;

  begin
    insert into public.agent_runs
      (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
    values
      (p_tenant_id, v_agent_slug, v_agent_hash, 'chat', 'queued', v_user_id,
       jsonb_build_object('thread_id', v_thread_id,
                          'user_message_id', v_msg_id,
                          'rerouted_from_run_id', p_run_id))
    returning id into v_new_run;
  exception
    when sqlstate 'P0001' then
      update public.agent_run_steers set status = 'dead' where id = any(v_ids);
      return jsonb_build_object('rerouted', 0, 'reason', 'reserve_failed',
                                'error', sqlerrm,
                                'dead', array_length(v_ids, 1));
  end;

  update public.agent_run_steers
     set status = 'rerouted'
   where id = any(v_ids);

  update public.agent_thread_messages m
     set agent_run_id = v_new_run
    from public.agent_run_steers s
   where s.id = any(v_ids)
     and s.user_message_id = m.id
     and m.tenant_id = p_tenant_id;

  return jsonb_build_object('rerouted', array_length(v_ids, 1),
                            'run_id', v_new_run,
                            'leased_count', coalesce(v_leased, 0));
end;
$$;

revoke all on function reroute_undrained_steers(uuid, uuid) from public, anon, authenticated;
grant execute on function reroute_undrained_steers(uuid, uuid) to service_role;

create or replace function sweep_undrained_steers(p_max_runs int default 20)
returns table (run_id uuid, tenant_id uuid, rerouted int, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v jsonb;
begin
  for r in
    select distinct s.run_id, s.tenant_id
    from public.agent_run_steers s
    join public.agent_runs ar on ar.id = s.run_id and ar.tenant_id = s.tenant_id
    where s.status in ('pending','leased')
      and ar.status not in ('queued','running','blocked')
      and coalesce(ar.finished_at, ar.started_at, now()) < now() - interval '2 minutes'
    order by s.run_id
    limit greatest(p_max_runs, 0)
  loop
    v := public.reroute_undrained_steers(r.run_id, r.tenant_id);
    run_id   := r.run_id;
    tenant_id := r.tenant_id;
    rerouted := coalesce((v->>'rerouted')::int, 0);
    reason   := v->>'reason';
    return next;
  end loop;
end;
$$;

revoke all on function sweep_undrained_steers(int) from public, anon, authenticated;
grant execute on function sweep_undrained_steers(int) to service_role;

comment on function sweep_undrained_steers(int) is
  'Mid-run barge-in reconciler: re-routes steers stranded on runs that terminalized OUTSIDE persistTerminal (watchdog/boot reap, Inngest onFailure, exec-gate failure). Guarantees no terminal path can silently eat a steered user message. Called from queued-stuck-scan.';
