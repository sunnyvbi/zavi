
begin;

create or replace function public.rule_propose(
  p_tenant_id   uuid,
  p_source_kind text,
  p_source_id   text,
  p_start       integer,
  p_end         integer,
  p_scope_kind  text,
  p_scope_slug  text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body    text;
  v_author  uuid;
  v_origin  text;
  v_text    text;
  v_run     agent_runs%rowtype;
  v_msg     record;
  v_id      uuid;
begin
  if p_tenant_id is null or p_source_id is null then
    raise exception 'rules: tenant and source are required' using errcode = '22023';
  end if;
  perform _rules_check_scope(p_scope_kind, p_scope_slug);

  if coalesce((select suggestions_paused from tenant_rule_settings where tenant_id = p_tenant_id), false) then
    return jsonb_build_object('status', 'paused');
  end if;

  if p_source_kind = 'chat_message' then
    select m.body, m.meta, m.agent_run_id, t.user_id as thread_user
      into v_msg
      from agent_thread_messages m
      join agent_threads t on t.id = m.thread_id and t.tenant_id = m.tenant_id
     where m.id = p_source_id::uuid
       and m.tenant_id = p_tenant_id
       and m.sender_role = 'user'
       and coalesce(m.content_kind, 'text') = 'text'
       and coalesce(m.source, 'chat') = 'chat'
       and not (coalesce(m.meta, '{}'::jsonb) ?| array['via', 'actor_source', 'clarification_response', 'superseded_by'])
       and m.agent_run_id is not null;
    if not found then return jsonb_build_object('status', 'not_allowed'); end if;
    select * into v_run from agent_runs
     where id = v_msg.agent_run_id and tenant_id = p_tenant_id;
    if v_run.id is null
       or v_run.trigger <> 'chat'
       or coalesce(v_run.payload ->> 'origin', '') = 'staff_console'
       or v_run.enqueued_by is distinct from v_msg.thread_user then
      return jsonb_build_object('status', 'not_allowed');
    end if;
    v_body := v_msg.body;
    v_author := v_msg.thread_user;
    v_origin := 'chat_typed';

  elsif p_source_kind = 'slack_run' then
    select * into v_run from agent_runs
     where id = p_source_id::uuid and tenant_id = p_tenant_id and trigger = 'slack';
    if v_run.id is null then return jsonb_build_object('status', 'not_allowed'); end if;
    v_body := v_run.payload -> 'slack' ->> 'text';
    v_author := resolve_slack_approver(p_tenant_id, v_run.payload -> 'slack' ->> 'user');
    v_origin := case when v_run.agent_slug = 'cgo' then 'cgo_slack_reply' else 'slack_typed' end;

  elsif p_source_kind = 'email_message' then
    select e.body_text, e.from_address into v_msg
      from email_messages e
     where e.id = p_source_id::uuid and e.tenant_id = p_tenant_id
       and e.direction = 'in' and e.sender_verified_member = true;
    if not found then return jsonb_build_object('status', 'not_allowed'); end if;
    v_body := v_msg.body_text;
    select tu.user_id into v_author
      from auth.users u
      join tenant_users tu on tu.user_id = u.id and tu.tenant_id = p_tenant_id
     where lower(u.email) = lower(substring(v_msg.from_address from '[^<\s]+@[^>\s]+'))
     limit 1;
    v_origin := 'cgo_email_reply';

  elsif p_source_kind = 'channel_reject' then
    select e.note, e.actor_user_id into v_msg
      from channel_action_events e
     where e.id = p_source_id::bigint and e.tenant_id = p_tenant_id
       and e.event = 'rejected' and e.actor_kind = 'founder';
    if not found then return jsonb_build_object('status', 'not_allowed'); end if;
    if not exists (select 1 from tenant_users where tenant_id = p_tenant_id
                     and user_id = v_msg.actor_user_id and role in ('owner', 'admin')) then
      return jsonb_build_object('status', 'not_allowed');
    end if;
    v_body := v_msg.note;
    v_author := v_msg.actor_user_id;
    v_origin := 'reject_reason';

  else
    return jsonb_build_object('status', 'not_allowed');
  end if;

  if v_author is null
     or not exists (select 1 from tenant_users where tenant_id = p_tenant_id
                      and user_id = v_author and role <> 'viewer') then
    return jsonb_build_object('status', 'not_allowed');
  end if;
  if v_body is null or p_start is null or p_end is null
     or p_start < 0 or p_end <= p_start or p_end > length(v_body) then
    return jsonb_build_object('status', 'bad_span');
  end if;

  v_text := _rules_clean_text(substr(v_body, p_start + 1, p_end - p_start));

  insert into tenant_rules (
    tenant_id, scope_kind, scope_slug, text, status, origin,
    source_ref, source_start, source_end, source_hash, excerpt,
    suggested_by, created_by
  ) values (
    p_tenant_id, p_scope_kind, p_scope_slug, v_text, 'suggested', v_origin,
    p_source_kind || ':' || p_source_id, p_start, p_end, md5(v_text),
    _rules_redact(substr(v_body, greatest(1, p_start + 1 - 120), (p_end - p_start) + 240)),
    'zavi', v_author
  )
  on conflict (tenant_id, origin, source_ref, source_hash) where source_ref is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'exists');
  end if;
  return jsonb_build_object('status', 'suggested', 'rule_id', v_id, 'text', v_text,
                            'author', v_author, 'origin', v_origin);
exception
  when invalid_parameter_value then
    return jsonb_build_object('status', 'refused', 'reason', sqlerrm);
end $$;
revoke all on function public.rule_propose(uuid, text, text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.rule_propose(uuid, text, text, integer, integer, text, text)
  to service_role;

insert into public.tenant_rules (
  tenant_id, scope_kind, scope_slug, text, status, origin,
  source_ref, source_hash, suggested_by, created_by, created_at
)
select f.tenant_id, 'agent', f.agent_slug,
       left(btrim(regexp_replace(f.comment, '\s+', ' ', 'g')), 280),
       'suggested', 'imported_rules_tab',
       'agent_feedback:' || f.id, md5(f.comment), f.created_by::text, f.created_by, f.created_at
  from public.agent_feedback f
 where f.kind = 'rule'
   and f.agent_slug is not null
   and length(btrim(coalesce(f.comment, ''))) > 0
   and f.comment !~ '\m\d{3}[ -]?\d{2}[ -]?\d{4}\M'
   and f.comment !~ '(\d[ -]?){13,19}'
on conflict (tenant_id, origin, source_ref, source_hash) where source_ref is not null
do nothing;

commit;
