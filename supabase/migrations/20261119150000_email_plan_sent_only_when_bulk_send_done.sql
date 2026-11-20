begin;

create or replace function public._email_plan_settle_from_bulk(p_tenant_id uuid, p_decision_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v email_bulk_sends%rowtype;
begin
  select * into v from email_bulk_sends s where s.tenant_id = p_tenant_id and s.decision_id = p_decision_id;
  if v.id is null or (v.status = 'done' and v.sent > 0) then
    perform public._email_plan_settle('decisions', p_decision_id, 'sent', null);
  elsif v.status not in ('done', 'failed') then
    return;
  elsif v.sent > 0 or v.unknown > 0 then
    perform public._email_plan_settle('decisions', p_decision_id, 'reconciling', 'may_have_sent');
  else
    perform public._email_plan_settle('decisions', p_decision_id, 'skipped', 'nobody_sent');
  end if;
end $$;
revoke all on function public._email_plan_settle_from_bulk(uuid, uuid) from public, anon, authenticated;

create or replace function public.decisions_email_ledger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text;
begin
  if new.decision_class is null or new.decision_class not in ('email_campaign.create_and_send', 'bulk_outbound.send') then
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'dispatch_failed' and new.dispatch_error is not distinct from 'not_sent_confirmed' then return new; end if;
  v_key := public._email_test_list_key(new.decision_class, new.body);
  if new.status = 'approved' and new.approved_by is not null then
    perform public._email_reserve(new.tenant_id, v_key, 'decisions', new.id, new.approved_by_source);
    perform public._email_plan_settle('decisions', new.id, 'sending', null);
  elsif new.status = 'acted' then
    perform public._email_reservation_settle('decisions', new.id, 'sent', null);
    perform public._email_plan_settle_from_bulk(new.tenant_id, new.id);
  elsif new.status = 'dispatch_failed'
        or (new.status = 'proposed' and old.status = 'dispatching' and new.approved_by is null) then
    if public._email_decision_send_started(new.tenant_id, new.id) then
      perform public._email_plan_settle('decisions', new.id, 'reconciling', 'may_have_sent');
    elsif new.status = 'dispatch_failed' then
      perform public._email_reservation_settle('decisions', new.id, 'released', 'dispatch_failed');
      perform public._email_plan_settle('decisions', new.id, 'skipped', coalesce(left(new.dispatch_error, 250), 'dispatch_failed'));
    else
      perform public._email_reservation_settle('decisions', new.id, 'released', 'held_for_founder');
      perform public._email_plan_settle('decisions', new.id, 'skipped', 'held: ' || coalesce(left(new.dispatch_error, 240), 'held'));
    end if;
  elsif new.status = 'rejected' then
    perform public._email_plan_settle('decisions', new.id, 'skipped', 'card_rejected');
  end if;
  return new;
end $$;
revoke all on function public.decisions_email_ledger() from public, anon, authenticated;

create or replace function public.email_bulk_sends_plan_settle() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from decisions d where d.tenant_id = new.tenant_id and d.id = new.decision_id and d.status = 'acted') then
    perform public._email_plan_settle_from_bulk(new.tenant_id, new.decision_id);
  end if;
  return new;
end $$;
revoke all on function public.email_bulk_sends_plan_settle() from public, anon, authenticated;
drop trigger if exists email_bulk_sends_plan_settle on public.email_bulk_sends;
create trigger email_bulk_sends_plan_settle after update of status on public.email_bulk_sends
  for each row
  when (new.status in ('done', 'failed') and old.status is distinct from new.status)
  execute function public.email_bulk_sends_plan_settle();

commit;
