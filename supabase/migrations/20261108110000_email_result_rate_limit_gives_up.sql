create or replace function public.complete_email_result_task(
  p_tenant_id uuid, p_task_id uuid, p_lease_token uuid, p_outcome text,
  p_result jsonb, p_next_due timestamptz, p_error text, p_ga jsonb, p_note text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t        email_result_tasks%rowtype;
  r        email_send_results%rowtype;
  v_state  text;
  v_merge  jsonb := coalesce(p_result, '{}'::jsonb);
  v_old_d7 jsonb;
  v_rid    uuid;
begin
  select result_id into v_rid from email_result_tasks where id = p_task_id and tenant_id = p_tenant_id;
  if v_rid is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform 1 from email_send_results where tenant_id = p_tenant_id and id = v_rid for update;
  select * into t from email_result_tasks
   where id = p_task_id and tenant_id = p_tenant_id for update;
  if t.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if t.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'not_owner');
  end if;
  select * into r from email_send_results where tenant_id = p_tenant_id and id = t.result_id for update;
  v_old_d7 := r.d7;

  if t.source = 'ga' and p_ga ? 'property_id' then
    if r.ga_property_id is not null and r.ga_property_id <> p_ga->>'property_id' then
      update email_result_tasks set lease_token = null, lease_until = null, state = 'gave_up',
             last_error = 'ga_property_changed', updated_at = now() where id = t.id;
      v_merge := jsonb_build_object('visitors', null, 'ga_status', 'property_changed');
      p_outcome := 'gave_up_merged';
    else
      update email_send_results
         set ga_property_id = coalesce(ga_property_id, left(p_ga->>'property_id', 40)),
             ga_timezone = coalesce(ga_timezone, left(nullif(p_ga->>'timezone', ''), 64))
       where id = r.id;
    end if;
  end if;

  if p_outcome = 'done' then
    v_state := 'done';
  elsif p_outcome = 'waiting' then
    v_state := case when coalesce(p_next_due, now()) > t.give_up_at then 'gave_up' else 'waiting' end;
  elsif p_outcome = 'rate_limited' then
    v_state := case when coalesce(p_next_due, now()) >= t.give_up_at then 'gave_up' else 'pending' end;
  elsif p_outcome = 'retry' then
    v_state := case when coalesce(p_next_due, now()) >= t.give_up_at then 'gave_up' else 'pending' end;
  elsif p_outcome in ('gave_up', 'gave_up_merged', 'disconnected') then
    v_state := 'gave_up';
  else
    return jsonb_build_object('ok', false, 'code', 'bad_outcome');
  end if;

  if p_outcome <> 'gave_up_merged' then
    update email_result_tasks
       set state = v_state,
           due_at = case when v_state in ('pending', 'waiting') then coalesce(p_next_due, now() + interval '10 minutes') else due_at end,
           attempts = attempts + case when p_outcome = 'retry' then 1 else 0 end,
           last_error = case when p_outcome in ('retry', 'gave_up', 'disconnected') then left(p_error, 300)
                             when p_outcome = 'rate_limited' and v_state = 'gave_up' then coalesce(left(p_error, 300), last_error)
                             else last_error end,
           lease_token = null, lease_until = null, updated_at = now()
     where id = t.id;
  end if;

  if v_state = 'gave_up' and p_outcome in ('retry', 'rate_limited', 'gave_up', 'disconnected') then
    v_merge := v_merge || jsonb_build_object(t.source || '_status', case when p_outcome = 'disconnected' then 'disconnected' else 'could_not_read' end);
  end if;
  if v_state = 'done' then
    v_merge := v_merge || jsonb_build_object(t.source || '_status', 'ok', t.source || '_as_of', now());
  end if;
  if v_merge <> '{}'::jsonb and v_state <> 'pending' then
    if t.stage = 'h1' then
      update email_send_results set h1 = h1 || v_merge, updated_at = now() where id = r.id;
    else
      update email_send_results set d7 = d7 || v_merge, updated_at = now() where id = r.id;
    end if;
  end if;

  if p_outcome = 'disconnected' then
    update email_result_tasks set state = 'gave_up', last_error = left(coalesce(p_error, 'disconnected'), 300),
           lease_token = null, lease_until = null, updated_at = now()
     where result_id = r.id and source = 'provider' and state in ('pending', 'waiting') and id <> t.id;
    update email_send_results
       set d7 = d7 || jsonb_build_object('provider_status', 'disconnected'),
           note = coalesce(left(p_note, 300), note), updated_at = now()
     where id = r.id;
  elsif p_note is not null then
    update email_send_results set note = left(p_note, 300), updated_at = now() where id = r.id;
  end if;

  perform public._email_result_finalize(r.id, v_old_d7);
  return jsonb_build_object('ok', true, 'state', v_state);
end $$;
revoke all on function public.complete_email_result_task(uuid, uuid, uuid, text, jsonb, timestamptz, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_email_result_task(uuid, uuid, uuid, text, jsonb, timestamptz, text, jsonb, text) to service_role;
