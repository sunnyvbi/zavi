begin;

create or replace function public.revise_pending_ad_action(
  p_tenant_id uuid, p_action_id uuid, p_actor_user_id uuid,
  p_expected_payload jsonb, p_expected_body jsonb, p_payload jsonb, p_body jsonb,
  p_request_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row channel_actions%rowtype;
  v_next uuid;
  v_position int;
  v_failed_clean boolean;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,128}$' then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id or not exists (
    select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id and role in ('owner','admin')
  ) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select revision_action_id into v_next from channel_action_events
    where action_id = p_action_id and event_key = 'ad-revision:' || p_request_id;
  if v_next is not null then
    if exists (select 1 from channel_actions where id = v_next and tenant_id = p_tenant_id and exec_payload = p_payload and body = p_body)
    then return jsonb_build_object('ok', true, 'action_id', v_next, 'replayed', true); end if;
    return jsonb_build_object('ok', false, 'code', 'action_changed');
  end if;
  v_failed_clean := coalesce(v_row.exec_status = 'failed'
    and v_row.exec_result->>'nothing_written' = 'true'
    and coalesce(v_row.exec_result->'created', 'null'::jsonb) in ('null'::jsonb, '[]'::jsonb, '{}'::jsonb)
    and coalesce(v_row.exec_result->>'interrupted', '') <> 'true'
    and coalesce(v_row.exec_result->>'lease_expired', '') <> 'true'
    and coalesce(v_row.exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
    and coalesce(v_row.exec_result->>'bucket', '') <> 'partial_risk'
    and (select count(*) from channel_action_events e where e.action_id = v_row.id and e.event = 'approved') = 1
    and not exists (select 1 from ad_object_changes c
                     where c.tenant_id = p_tenant_id and c.action_table = 'channel_actions' and c.action_id = v_row.id), false);
  if v_row.status <> 'pending'
    or not ((v_row.exec_status is null and v_row.approved_by is null) or v_failed_clean)
    or v_row.exec_class is null or v_row.exec_payload is distinct from p_expected_payload
    or v_row.body is distinct from p_expected_body
    or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_body) is distinct from 'object'
    or v_row.channel_slug not in ('meta_ads','google_ads','youtube_ads','tiktok_ads','linkedin_ads','reddit_ads','x_ads','chatgpt_ads')
  then return jsonb_build_object('ok', false, 'code', 'action_changed'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_row.run_id::text, 7));
  select coalesce(max(position), 0) + 1 into v_position from channel_actions where run_id = v_row.run_id;
  v_next := gen_random_uuid();
  update channel_actions set status = 'redone', status_at = now(), note = 'Revised by you.' where id = p_action_id;
  insert into channel_actions (
    id, tenant_id, channel_slug, run_id, position, run_of, blocking, action_type, title, title_key,
    body, edited_body, status, redo_of, baseline_metrics, impact, impact_reason, score, score_inputs, score_version,
    scored_at, proposed_at, exec_class, exec_payload, card_kind, primary_label, done_label, how_to, target_key, cgo_hold
  ) values (
    v_next, p_tenant_id, v_row.channel_slug, v_row.run_id, v_position, greatest(v_position, v_row.run_of),
    v_row.blocking, v_row.action_type, v_row.title, v_row.title_key, p_body, jsonb_build_object('ad_review_edited', true), 'pending', p_action_id,
    v_row.baseline_metrics, null, null, 0, '{}', v_row.score_version,
    null, now(), v_row.exec_class, p_payload, v_row.card_kind, v_row.primary_label, v_row.done_label, v_row.how_to, v_row.target_key, v_row.cgo_hold
  );
  insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key, revision_action_id)
    values (p_tenant_id, p_action_id, 'revised', 'founder', p_actor_user_id, v_row.run_id,
      'Revised by you.', 'ad-revision:' || p_request_id, v_next),
      (p_tenant_id, v_next, 'proposed', 'founder', p_actor_user_id, v_row.run_id, 'Revised by you.', 'proposed:' || v_next, null);
  return jsonb_build_object('ok', true, 'action_id', v_next);
end $$;
revoke all on function public.revise_pending_ad_action(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.revise_pending_ad_action(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) to service_role;

commit;
