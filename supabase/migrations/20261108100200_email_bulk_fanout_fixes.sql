begin;

alter table public.email_send_counters add column if not exists bulk_sent_count int not null default 0;
update public.email_send_counters c
   set bulk_sent_count = least(c.sent_count, (
     select count(*)::int from public.email_bulk_send_recipients r
      where r.tenant_id = c.tenant_id and (r.stamped_at at time zone 'utc')::date = c.day
        and r.status in ('sending', 'sent', 'failed', 'unknown')
   ))
 where c.bulk_sent_count = 0 and c.sent_count > 0;
alter table public.email_bulk_sends add column if not exists fanout_recoveries int not null default 0;
alter table public.email_bulk_sends add column if not exists fanout_recovered_at timestamptz;

create or replace function public._email_bulk_refund_claim(p_tenant_id uuid, p_send_id uuid, p_contact_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.email_send_counters c
     set sent_count = greatest(c.sent_count - 1, 0), bulk_sent_count = greatest(c.bulk_sent_count - 1, 0), updated_at = now()
    from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id and r.status = 'sending'
     and c.tenant_id = p_tenant_id and c.day = (r.stamped_at at time zone 'utc')::date;
$$;
revoke all on function public._email_bulk_refund_claim(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.email_bulk_claim_next(
  p_tenant_id uuid,
  p_send_id   uuid,
  p_daily_cap int
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_status    text;
  v_from      text;
  v_domain    text;
  v_day       date := (now() at time zone 'utc')::date;
  v_day_index int;
  v_w_index   int;
  v_w_last    date;
  v_warmup    int;
  v_contact   uuid;
  v_email     text;
  v_erased    timestamptz;
  v_reason    text;
  v_count     int;
begin
  if p_tenant_id is null or p_send_id is null or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'email_bulk_claim_next: invalid argument' using errcode = '22023';
  end if;
  select s.status, s.from_address into v_status, v_from from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if v_status is distinct from 'sending' then
    return jsonb_build_object('outcome', 'held');
  end if;
  if not exists (
    select 1
      from public.email_bulk_sends s
      join public.email_lists l on l.tenant_id = s.tenant_id and l.id = s.list_id
      join public.email_list_versions lv
        on lv.tenant_id = s.tenant_id and lv.list_id = s.list_id and lv.id = s.list_version_id
     where s.id = p_send_id and s.tenant_id = p_tenant_id
       and l.archived_at is null and lv.consent_confirmed_at is not null
  ) then
    return jsonb_build_object('outcome', 'held');
  end if;
  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('outcome', 'held');
  end if;

  select r.contact_id, r.email_at_send, c.erased_at
    into v_contact, v_email, v_erased
    from public.email_bulk_send_recipients r
    join public.email_contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'pending'
   order by r.contact_id
   limit 1
   for update of r skip locked;
  if v_contact is null then
    return jsonb_build_object('outcome', 'none_pending');
  end if;

  if v_erased is not null or v_email is null then
    v_reason := 'erased';
  else
    v_reason := public.email_bulk_block_reason(p_tenant_id, v_email);
  end if;
  if v_reason is not null then
    update public.email_bulk_send_recipients r
       set status = 'skipped', skip_reason = v_reason, stamped_at = now()
     where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = v_contact;
    return jsonb_build_object('outcome', 'skipped', 'reason', v_reason);
  end if;

  v_domain := nullif(lower(split_part(coalesce(v_from, ''), '@', 2)), '');
  if v_domain is null then
    raise exception 'email_bulk_claim_next: send has no sending domain' using errcode = '22023';
  end if;
  select w.day_index, w.last_sent_on into v_w_index, v_w_last
    from public.email_domain_warmup w
   where w.tenant_id = p_tenant_id and w.domain = v_domain
   for update;
  v_day_index := case
    when v_w_index is null then 0
    when v_w_last is null or v_w_last < v_day then v_w_index + 1
    else v_w_index
  end;
  v_warmup := case when v_day_index >= 10 then 0 else 50 * (2 ^ greatest(v_day_index, 0))::int end;
  insert into public.email_send_counters (tenant_id, day)
  values (p_tenant_id, v_day)
  on conflict (tenant_id, day) do nothing;
  update public.email_send_counters
     set sent_count = sent_count + 1, bulk_sent_count = bulk_sent_count + 1, updated_at = now()
   where tenant_id = p_tenant_id and day = v_day
     and (v_warmup = 0 or bulk_sent_count + 1 <= v_warmup)
     and (p_daily_cap = 0 or sent_count + 1 <= p_daily_cap)
  returning sent_count into v_count;
  if v_count is null then
    return jsonb_build_object('outcome', 'allowance_exhausted', 'day_index', v_day_index);
  end if;

  update public.email_bulk_send_recipients r
     set status = 'sending', stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = v_contact;
  return jsonb_build_object('outcome', 'claimed', 'contact_id', v_contact, 'email', v_email, 'day_index', v_day_index);
end $$;
revoke all on function public.email_bulk_claim_next(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.email_bulk_claim_next(uuid, uuid, int) to service_role;

create or replace function public.email_bulk_skip_if_blocked(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid
) returns text
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_status text; v_skip text; v_email text; v_erased timestamptz; v_reason text;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null then
    raise exception 'email_bulk_skip_if_blocked: null argument' using errcode = '22023';
  end if;
  select r.status, r.skip_reason, r.email_at_send, c.erased_at
    into v_status, v_skip, v_email, v_erased
    from public.email_bulk_send_recipients r
    join public.email_contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
   for update of r;
  if not found then
    return 'not_found';
  end if;
  if v_status = 'skipped' then
    return coalesce(v_skip, 'skipped');
  end if;
  if v_status <> 'sending' then
    return 'not_claimed';
  end if;
  if v_erased is not null or v_email is null then
    v_reason := 'erased';
  else
    v_reason := public.email_bulk_block_reason(p_tenant_id, v_email);
  end if;
  if v_reason is not null then
    perform public._email_bulk_refund_claim(p_tenant_id, p_send_id, p_contact_id);
    update public.email_bulk_send_recipients r
       set status = 'skipped', skip_reason = v_reason, stamped_at = now()
     where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id;
  end if;
  return v_reason;
end $$;
revoke all on function public.email_bulk_skip_if_blocked(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_skip_if_blocked(uuid, uuid, uuid) to service_role;

create or replace function public.email_bulk_requeue_claimed(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null then
    raise exception 'email_bulk_requeue_claimed: null argument' using errcode = '22023';
  end if;
  perform public._email_bulk_refund_claim(p_tenant_id, p_send_id, p_contact_id);
  update public.email_bulk_send_recipients r
     set status = 'pending', stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
     and r.status = 'sending';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_requeue_claimed(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_requeue_claimed(uuid, uuid, uuid) to service_role;

create or replace function public.email_bulk_stalled_sends(p_limit int, p_stale_minutes int, p_max_recoveries int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r     record;
  v_out jsonb := '[]'::jsonb;
  v_age interval := make_interval(mins => greatest(coalesce(p_stale_minutes, 45), 15));
begin
  for r in
    select s.*
      from email_bulk_sends s
     where s.status in ('sending', 'waiting_for_tomorrow')
       and greatest(s.created_at, coalesce(s.fanout_recovered_at, s.created_at),
                    coalesce((select max(x.stamped_at) from email_bulk_send_recipients x
                               where x.send_id = s.id and x.tenant_id = s.tenant_id), s.created_at)) < now() - v_age
       and (s.status = 'sending' or coalesce(s.next_run_at, s.created_at) < now() - v_age)
     order by s.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of s skip locked
  loop
    if r.fanout_recoveries >= greatest(coalesce(p_max_recoveries, 3), 0) then
      update email_bulk_sends set status = 'held', hold_reason = 'fanout_stalled', next_run_at = null
       where id = r.id and status in ('sending', 'waiting_for_tomorrow');
      v_out := v_out || jsonb_build_object('action', 'give_up', 'send_id', r.id, 'tenant_id', r.tenant_id, 'decision_id', r.decision_id,
                                           'sent', r.sent, 'total', r.total);
    else
      update email_bulk_sends set fanout_recoveries = fanout_recoveries + 1, fanout_recovered_at = now(),
             status = case when status = 'waiting_for_tomorrow' then 'sending' else status end,
             next_run_at = case when status = 'waiting_for_tomorrow' then null else next_run_at end
       where id = r.id;
      v_out := v_out || jsonb_build_object('action', 'refire', 'send_id', r.id, 'tenant_id', r.tenant_id,
                                           'decision_id', r.decision_id, 'attempt', r.fanout_recoveries + 1);
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.email_bulk_stalled_sends(int, int, int) from public, anon, authenticated;
grant execute on function public.email_bulk_stalled_sends(int, int, int) to service_role;

create or replace function public.email_bulk_stop_send(p_tenant_id uuid, p_actor_user_id uuid, p_decision_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v       email_bulk_sends%rowtype;
  v_n     int;
  v_sent  int;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_decision_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select * into v from email_bulk_sends s where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id for update;
  if v.id is null or v.status not in ('sending', 'waiting_for_tomorrow', 'held') then
    return jsonb_build_object('ok', false, 'code', 'not_stoppable', 'status', v.status);
  end if;
  update email_bulk_send_recipients r
     set status = 'skipped', skip_reason = 'stopped', stamped_at = now()
   where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'pending';
  get diagnostics v_n = row_count;
  update email_bulk_sends s set status = 'held', hold_reason = 'stopped', next_run_at = null
   where s.id = v.id;
  select count(*) into v_sent from email_bulk_send_recipients r
   where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'sent';
  update email_bulk_sends s set sent = v_sent,
         skipped = (select count(*) from email_bulk_send_recipients r where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'skipped')
   where s.id = v.id;
  return jsonb_build_object('ok', true, 'stopped', v_n, 'already_sent', v_sent);
end $$;
revoke all on function public.email_bulk_stop_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_stop_send(uuid, uuid, uuid) to service_role;

commit;
