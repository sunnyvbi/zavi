begin;

create or replace function public.block_email_plan_draft(
  p_tenant_id uuid, p_id uuid, p_job_id uuid, p_lease_token uuid, p_version int, p_code text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row email_planned_sends%rowtype;
  v_key text;
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,80}$' or p_version is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select j.job_key into v_key from email_plan_jobs j
   where j.id = p_job_id and j.tenant_id = p_tenant_id and j.item_id = p_id and j.kind = 'draft'
     and j.state = 'leased' and j.lease_token = p_lease_token and j.lease_until > clock_timestamp()
     for update;
  if v_key is null
     or v_row.content_version is distinct from p_version
     or not (v_key = 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen
             or v_key like 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen || ':%') then
    return jsonb_build_object('ok', true, 'blocked', false, 'reason', 'superseded');
  end if;
  if v_row.status not in ('planned', 'drafting') or v_row.card_id is not null then
    return jsonb_build_object('ok', true, 'blocked', false, 'status', v_row.status);
  end if;
  if v_row.draft_attempts < 1 then
    update email_planned_sends set status_reason = 'draft_blocked:' || p_code, updated_at = now() where id = p_id;
    return jsonb_build_object('ok', true, 'blocked', false, 'status', v_row.status);
  end if;
  update email_planned_sends set status = 'blocked', status_reason = 'draft_blocked:' || p_code, updated_at = now() where id = p_id;
  update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = left('draft_blocked:' || p_code, 200)
   where tenant_id = p_tenant_id and item_id = p_id and kind = 'draft' and state = 'pending';
  return jsonb_build_object('ok', true, 'blocked', true, 'status', 'blocked', 'reason', 'draft_blocked:' || p_code);
end $$;
revoke all on function public.block_email_plan_draft(uuid, uuid, uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.block_email_plan_draft(uuid, uuid, uuid, uuid, int, text) to service_role;

create or replace function public._email_plan_held_reason() returns trigger
language plpgsql as $$
begin
  if old.draft_attempts < 1 and old.status_reason like 'draft_blocked:%' then
    if new.status = 'drafting' then
      new.status_reason := null;
    elsif new.status = 'skipped' and new.status_reason = 'no_draft' then
      new.status_reason := old.status_reason;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._email_plan_held_reason() from public, anon, authenticated;

drop trigger if exists email_planned_sends_held_reason on public.email_planned_sends;
create trigger email_planned_sends_held_reason before update of status, status_reason on public.email_planned_sends
  for each row execute function public._email_plan_held_reason();

commit;
